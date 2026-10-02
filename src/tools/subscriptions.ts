import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient, UploadOperation } from "#/client/asc";
import { attributesOf, type Rec, relatedId, resourceOf, summarizeResponse } from "#/client/shape";
// Aliased for the same reason as in iap.ts: assets.ts's `attributesOf` takes a
// whole response envelope, shape.ts's takes a resource.
import {
  attributesOf as envelopeAttributes,
  idOf,
  pollAssetState,
  readImage,
} from "#/tools/assets";
import {
  appIdArg,
  compact,
  confirmArg,
  customerPriceArg,
  getOrNull,
  limitArg,
  PreconditionError,
  pricePointsAt,
  savePathArg,
  territoryArg,
  wrap,
  wrapSaved,
} from "#/tools/util";

const SUBSCRIPTION_PERIODS = [
  "ONE_WEEK",
  "ONE_MONTH",
  "TWO_MONTHS",
  "THREE_MONTHS",
  "SIX_MONTHS",
  "ONE_YEAR",
] as const;

const OFFER_DURATIONS = [
  "THREE_DAYS",
  "ONE_WEEK",
  "TWO_WEEKS",
  "ONE_MONTH",
  "TWO_MONTHS",
  "THREE_MONTHS",
  "SIX_MONTHS",
  "ONE_YEAR",
] as const;

const OFFER_MODES = ["FREE_TRIAL", "PAY_AS_YOU_GO", "PAY_UP_FRONT"] as const;

const groupIdArg = z
  .string()
  .min(1)
  .describe("The subscriptionGroup id (from app_store_connect_list_subscription_groups).");

const subscriptionIdArg = z
  .string()
  .min(1)
  .describe(
    "The subscription id (from app_store_connect_list_subscriptions), NOT the productId string.",
  );

const subscriptionLocalizationIdArg = z
  .string()
  .min(1)
  .describe(
    "The subscriptionLocalization id (from app_store_connect_list_subscription_localizations).",
  );

/**
 * Same limits as a one-time purchase: 30 for the display name, 45 for the
 * description, counted in UTF-16 code units (`String.length`). Apple's 409 for
 * an over-length value names neither the field nor the limit.
 */
const SUBSCRIPTION_FIELD_LIMITS = { name: 30, description: 45 } as const;

const assertWithinLimits = (fields: { name?: string; description?: string }): void => {
  for (const [field, limit] of Object.entries(SUBSCRIPTION_FIELD_LIMITS)) {
    const value = fields[field as keyof typeof SUBSCRIPTION_FIELD_LIMITS];
    if (value === undefined || value.length <= limit) continue;
    throw new PreconditionError(
      `The subscription ${field} is ${value.length} characters, over Apple's ${limit}-character ` +
        `limit. Shorten it before retrying — App Store Connect rejects this without saying which ` +
        `field was too long.`,
      { field, limit, length: value.length, value },
    );
  }
};

/**
 * A price point names one amount in one territory. Pricing with an id from the
 * wrong territory is accepted by Apple and charges the wrong amount, so it is
 * checked here, before anything is written.
 */
const assertPricePointBelongs = async (
  client: AppStoreConnectClient,
  subscriptionId: string,
  pricePointId: string,
  territory: string,
): Promise<Rec> => {
  const { data } = await client.getAll<Rec>(`/v1/subscriptions/${subscriptionId}/pricePoints`, {
    "filter[territory]": territory,
    limit: 200,
  });
  const match = data.find((point) => point.id === pricePointId);
  if (match !== undefined) return attributesOf(match);
  throw new PreconditionError(
    `Price point ${pricePointId} is not one of this subscription's ${territory} price points. ` +
      `List them with app_store_connect_list_subscription_price_points and pass an id from that ` +
      `response.`,
    { subscriptionId, pricePointId, territory, availablePricePoints: data.length },
  );
};

/**
 * Run `fn` over `items`, a few at a time. Pricing a subscription everywhere is
 * ~175 POSTs; one at a time takes minutes, all at once trips Apple's rate limit.
 * The client already retries 429s, so a small pool is enough.
 */
const inPool = async <T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
};

export const registerSubscriptionTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_subscription_groups",
    {
      title: "App Store Connect: List Subscription Groups",
      description:
        "List an app's subscription groups (reference name and state). Auto-renewable " +
        "subscriptions always live inside a group: a customer can hold one subscription per " +
        "group, and upgrades/downgrades happen within it. Returns the group ids the other " +
        "subscription tools take.",
      inputSchema: z.object({ appId: appIdArg, limit: limitArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(await client.get(`/v1/apps/${appId}/subscriptionGroups`, { limit })),
      ),
  );

  server.registerTool(
    "app_store_connect_list_subscriptions",
    {
      title: "App Store Connect: List Subscriptions",
      description:
        "List the auto-renewable subscriptions in a group: reference name, productId, period, " +
        "group level and review state. `MISSING_METADATA` usually means a display name and " +
        "description, a price, availability or a review screenshot is still missing.",
      inputSchema: z.object({ groupId: groupIdArg, limit: limitArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ groupId, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(`/v1/subscriptionGroups/${groupId}/subscriptions`, { limit }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_subscription",
    {
      title: "App Store Connect: Get Subscription",
      description: "Get one subscription's attributes, including its review `state`.",
      inputSchema: z.object({ subscriptionId: subscriptionIdArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(await client.get(`/v1/subscriptions/${subscriptionId}`)),
      ),
  );

  server.registerTool(
    "app_store_connect_list_subscription_localizations",
    {
      title: "App Store Connect: List Subscription Localizations",
      description:
        "List a subscription's per-locale display name and description — the copy customers see " +
        "on the purchase sheet and in Settings. Returns the localization ids the update tool takes.",
      inputSchema: z.object({
        subscriptionId: subscriptionIdArg,
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(`/v1/subscriptions/${subscriptionId}/subscriptionLocalizations`, {
            limit,
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_subscription_price_points",
    {
      title: "App Store Connect: List Subscription Price Points",
      description:
        "List the price points a subscription can be sold at in one territory — each an id plus " +
        "the customer price and your proceeds. Pick one and pass its id to " +
        "app_store_connect_set_subscription_price. Apple publishes hundreds per territory, so " +
        "raise the limit when hunting a specific price.",
      inputSchema: z.object({
        subscriptionId: subscriptionIdArg,
        territory: territoryArg,
        customerPrice: customerPriceArg,
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, territory, customerPrice, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        customerPrice !== undefined
          ? pricePointsAt(
              client,
              `/v1/subscriptions/${subscriptionId}/pricePoints`,
              territory,
              customerPrice,
            )
          : summarizeResponse(
              await client.get(`/v1/subscriptions/${subscriptionId}/pricePoints`, {
                "filter[territory]": territory,
                limit,
              }),
            ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_subscription_prices",
    {
      title: "App Store Connect: List Subscription Prices",
      description:
        "Show what a subscription costs: each price in force with its territory, start date, " +
        "customer price and proceeds. An empty list means it has never been priced. Filter by " +
        "territory to check one storefront.",
      inputSchema: z.object({
        subscriptionId: subscriptionIdArg,
        territory: territoryArg.optional(),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, territory, limit, savePath }) =>
      wrapSaved(savePath, async () => {
        const response = await client.get(
          `/v1/subscriptions/${subscriptionId}/prices`,
          compact({
            "filter[territory]": territory,
            include: "subscriptionPricePoint,territory",
            limit,
          }),
        );
        const points = new Map(
          ((response as { included?: Rec[] }).included ?? [])
            .filter((r) => r.type === "subscriptionPricePoints")
            .map((r) => [r.id, attributesOf(r)]),
        );
        const prices = ((response as { data?: Rec[] }).data ?? []).map((price) => {
          const pointId = relatedId(price, "subscriptionPricePoint");
          const point = pointId === undefined ? {} : (points.get(pointId) ?? {});
          return {
            id: price.id,
            ...attributesOf(price),
            territory: relatedId(price, "territory"),
            pricePointId: pointId,
            customerPrice: point.customerPrice,
            proceeds: point.proceeds,
          };
        });
        return { prices, count: prices.length };
      }),
  );

  server.registerTool(
    "app_store_connect_list_subscription_introductory_offers",
    {
      title: "App Store Connect: List Subscription Introductory Offers",
      description:
        "List a subscription's introductory offers (free trials and discounted first periods), " +
        "one per territory, with mode, duration and dates.",
      inputSchema: z.object({
        subscriptionId: subscriptionIdArg,
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(`/v1/subscriptions/${subscriptionId}/introductoryOffers`, {
            include: "territory",
            limit,
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_subscription_availability",
    {
      title: "App Store Connect: Get Subscription Availability",
      description:
        "Show which territories a subscription is sold in and whether it joins territories Apple " +
        "adds later. `data: null` means availability was never set — one of the requirements " +
        "that keeps a subscription at MISSING_METADATA.",
      inputSchema: z.object({ subscriptionId: subscriptionIdArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, savePath }) =>
      wrapSaved(savePath, async () => {
        const response = await getOrNull(
          client,
          `/v1/subscriptions/${subscriptionId}/subscriptionAvailability`,
        );
        if (response === null) {
          return { data: null, note: "Availability has never been set for this subscription." };
        }
        const availability = resourceOf(response);
        if (typeof availability.id !== "string") return { data: null };
        const { data: territories } = await client.getAll<Rec>(
          `/v1/subscriptionAvailabilities/${availability.id}/availableTerritories`,
          { limit: 200 },
        );
        return {
          id: availability.id,
          ...attributesOf(availability),
          availableTerritories: territories.map((t) => t.id),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_get_subscription_review_screenshot",
    {
      title: "App Store Connect: Get Subscription Review Screenshot",
      description:
        "Get the review screenshot attached to a subscription, with its `assetDeliveryState` — " +
        "the way to check an upload finished processing. Returns nothing when none is attached.",
      inputSchema: z.object({ subscriptionId: subscriptionIdArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, savePath }) =>
      wrapSaved(savePath, async () => {
        const response = await getOrNull(
          client,
          `/v1/subscriptions/${subscriptionId}/appStoreReviewScreenshot`,
        );
        return response === null ? { data: null } : summarizeResponse(response);
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_subscription_group",
    {
      title: "App Store Connect: Create Subscription Group",
      description:
        "Create a subscription group for an app. Put every plan of one product (monthly, yearly) " +
        "in the same group, so a customer holds one at a time and can switch between them. The " +
        "reference name is internal; customers see the group's display name, set with " +
        "app_store_connect_create_subscription_group_localization (required before submission).",
      inputSchema: z.object({
        appId: appIdArg,
        referenceName: z
          .string()
          .min(1)
          .describe('Internal name shown only in App Store Connect, e.g. "Pro".'),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ appId, referenceName }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/subscriptionGroups", {
            data: {
              type: "subscriptionGroups",
              attributes: { referenceName },
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_create_subscription_group_localization",
    {
      title: "App Store Connect: Create Subscription Group Localization",
      description:
        "Set the customer-facing name of a subscription group for one locale (shown in the " +
        "subscription management screen in Settings). Apple requires at least one before any " +
        "subscription in the group can be submitted.",
      inputSchema: z.object({
        groupId: groupIdArg,
        locale: z.string().min(2).describe('The locale, e.g. "en-US". One per locale.'),
        name: z.string().min(1).describe('Display name of the group, e.g. "ReportShot Pro".'),
        customAppName: z
          .string()
          .optional()
          .describe("App name to show with the subscription, if not the app's own name."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ groupId, locale, name, customAppName }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/subscriptionGroupLocalizations", {
            data: {
              type: "subscriptionGroupLocalizations",
              attributes: compact({ name, locale, customAppName }),
              relationships: {
                subscriptionGroup: { data: { type: "subscriptionGroups", id: groupId } },
              },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_create_subscription",
    {
      title: "App Store Connect: Create Subscription",
      description:
        "Create an auto-renewable subscription in a group. The productId is permanent — it must " +
        "match what the app asks StoreKit for, and it can never be reused, even after deletion. " +
        "After creating it, add a localization, a price, availability and a review screenshot " +
        "before it can be submitted.",
      inputSchema: z.object({
        groupId: groupIdArg,
        productId: z
          .string()
          .min(1)
          .describe('The StoreKit product identifier, e.g. "com.acme.app.pro.yearly". Permanent.'),
        name: z
          .string()
          .min(1)
          .describe('Internal reference name shown only in App Store Connect, e.g. "Pro Yearly".'),
        subscriptionPeriod: z.enum(SUBSCRIPTION_PERIODS).describe("How often it renews."),
        groupLevel: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Rank within the group: 1 is the highest level of service. Plans offering the same " +
              "service at different durations share a level.",
          ),
        familySharable: z
          .boolean()
          .optional()
          .describe("Whether Family Sharing covers it. Turning it off later is a takeback."),
        reviewNote: z.string().optional().describe("Note to App Review. Shown only to Apple."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({
      groupId,
      productId,
      name,
      subscriptionPeriod,
      groupLevel,
      familySharable,
      reviewNote,
    }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/subscriptions", {
            data: {
              type: "subscriptions",
              attributes: compact({
                name,
                productId,
                subscriptionPeriod,
                groupLevel,
                familySharable,
                reviewNote,
              }),
              relationships: { group: { data: { type: "subscriptionGroups", id: groupId } } },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_update_subscription",
    {
      title: "App Store Connect: Update Subscription",
      description:
        "Update a subscription's own attributes: reference name, review note, group level, " +
        "Family Sharing. Only the fields you pass change. The period can't be changed here once " +
        "the subscription has been approved.",
      inputSchema: z.object({
        subscriptionId: subscriptionIdArg,
        name: z.string().optional().describe("Internal reference name. Not customer-facing."),
        reviewNote: z.string().optional().describe("Note to App Review. Shown only to Apple."),
        groupLevel: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Rank within the group; 1 is highest."),
        familySharable: z
          .boolean()
          .optional()
          .describe("Enabling is safe; disabling after customers subscribed is a takeback."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ subscriptionId, confirm: _confirm, ...attributes }) =>
      wrap(async () =>
        summarizeResponse(
          await client.patch(`/v1/subscriptions/${subscriptionId}`, {
            data: { type: "subscriptions", id: subscriptionId, attributes: compact(attributes) },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_create_subscription_localization",
    {
      title: "App Store Connect: Create Subscription Localization",
      description:
        "Add the customer-facing display name and description of a subscription for one locale. " +
        "Limits: 30 characters for the name, 45 for the description. Use " +
        "app_store_connect_update_subscription_localization for a locale that already exists.",
      inputSchema: z.object({
        subscriptionId: subscriptionIdArg,
        locale: z.string().min(2).describe('The locale, e.g. "en-US".'),
        name: z.string().min(1).describe("Display name customers see (30-char limit)."),
        description: z
          .string()
          .optional()
          .describe("What the subscription gives, shown to customers (45-char limit)."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ subscriptionId, locale, name, description }) =>
      wrap(async () => {
        assertWithinLimits({ name, description });
        return summarizeResponse(
          await client.post("/v1/subscriptionLocalizations", {
            data: {
              type: "subscriptionLocalizations",
              attributes: compact({ name, locale, description }),
              relationships: {
                subscription: { data: { type: "subscriptions", id: subscriptionId } },
              },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_update_subscription_localization",
    {
      title: "App Store Connect: Update Subscription Localization",
      description:
        "Change the display name or description of one existing subscription locale. Only the " +
        "fields you pass change. Name is limited to 30 characters and description to 45.",
      inputSchema: z.object({
        localizationId: subscriptionLocalizationIdArg,
        name: z.string().optional().describe("Display name customers see (30-char limit)."),
        description: z.string().optional().describe("Shown to customers (45-char limit)."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ localizationId, confirm: _confirm, ...attributes }) =>
      wrap(async () => {
        assertWithinLimits(attributes);
        return summarizeResponse(
          await client.patch(`/v1/subscriptionLocalizations/${localizationId}`, {
            data: {
              type: "subscriptionLocalizations",
              id: localizationId,
              attributes: compact(attributes),
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_set_subscription_price",
    {
      title: "App Store Connect: Set Subscription Price",
      description:
        "Price a subscription from one price point (from " +
        "app_store_connect_list_subscription_price_points). With `allTerritories` (the default) " +
        "every other territory gets Apple's equalized price for that point — what the App Store " +
        "Connect UI does — which is ~175 requests and takes a minute. Unlike one-time purchases, " +
        "subscriptions are priced per territory: with `allTerritories: false` only the base " +
        "territory is priced and the others can't sell it. On a live subscription the new price " +
        "reaches real customers; pass `startDate` to schedule it, and `preserveCurrentPrice` to " +
        "keep existing subscribers on their old price. Leave startDate out for a subscription " +
        "that hasn't been approved yet.",
      inputSchema: z.object({
        subscriptionId: subscriptionIdArg,
        pricePointId: z
          .string()
          .min(1)
          .describe("The subscriptionPricePoint id to charge. Must belong to baseTerritory."),
        baseTerritory: territoryArg.describe(
          'The territory the price point belongs to and that the others are equalized from, e.g. "USA".',
        ),
        allTerritories: z
          .boolean()
          .default(true)
          .describe("Also set Apple's equalized price in every other territory. Defaults to true."),
        startDate: z.string().optional().describe('"YYYY-MM-DD". Omit to apply it now.'),
        preserveCurrentPrice: z
          .boolean()
          .optional()
          .describe("Keep existing subscribers on the price they pay today."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({
      subscriptionId,
      pricePointId,
      baseTerritory,
      allTerritories,
      startDate,
      preserveCurrentPrice,
    }) =>
      wrap(async () => {
        const base = await assertPricePointBelongs(
          client,
          subscriptionId,
          pricePointId,
          baseTerritory,
        );

        const targets: { territory: string; pricePointId: string }[] = [
          { territory: baseTerritory, pricePointId },
        ];
        if (allTerritories) {
          const { data } = await client.getAll<Rec>(
            `/v1/subscriptionPricePoints/${pricePointId}/equalizations`,
            { include: "territory", limit: 200 },
          );
          for (const point of data) {
            const territory = relatedId(point, "territory");
            if (typeof point.id !== "string" || territory === undefined) continue;
            if (territory === baseTerritory) continue;
            targets.push({ territory, pricePointId: point.id });
          }
        }

        const results = await inPool(targets, 4, async (target) => {
          try {
            await client.post("/v1/subscriptionPrices", {
              data: {
                type: "subscriptionPrices",
                attributes: compact({ startDate, preserveCurrentPrice }),
                relationships: {
                  subscription: { data: { type: "subscriptions", id: subscriptionId } },
                  territory: { data: { type: "territories", id: target.territory } },
                  subscriptionPricePoint: {
                    data: { type: "subscriptionPricePoints", id: target.pricePointId },
                  },
                },
              },
            });
            return { territory: target.territory, ok: true as const };
          } catch (err) {
            return {
              territory: target.territory,
              ok: false as const,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        });

        const failed = results.filter((r) => !r.ok);
        return {
          priced: {
            pricePointId,
            baseTerritory,
            customerPrice: base.customerPrice,
            proceeds: base.proceeds,
            startDate: startDate ?? "immediate",
          },
          territoriesPriced: results.length - failed.length,
          ...(failed.length > 0
            ? {
                failed,
                note:
                  "Some territories were not priced. Calling this again is safe: it sets the " +
                  "same prices, and the ones already set stay as they are.",
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_set_subscription_availability",
    {
      title: "App Store Connect: Set Subscription Availability",
      description:
        "Choose the territories a subscription is sold in. Omit `territories` for every " +
        "territory Apple offers, the App Store Connect default. Can only be set once per " +
        "subscription; Apple rejects a second one.",
      inputSchema: z.object({
        subscriptionId: subscriptionIdArg,
        territories: z
          .array(z.string().length(3))
          .optional()
          .describe('Territory codes, e.g. ["USA","GBR"]. Omit for every territory.'),
        availableInNewTerritories: z
          .boolean()
          .default(true)
          .describe("Join territories Apple opens later automatically."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ subscriptionId, territories, availableInNewTerritories }) =>
      wrap(async () => {
        const resolved =
          territories ??
          (await client.getAll<Rec>("/v1/territories", { limit: 200 })).data.flatMap((t) =>
            typeof t.id === "string" ? [t.id] : [],
          );
        if (resolved.length === 0) {
          throw new PreconditionError(
            "No territories resolved, so the subscription would be sold nowhere. Pass " +
              "`territories` explicitly.",
            { subscriptionId },
          );
        }
        // ponytail: /v1/subscriptionAvailabilities is deprecated in API 4.5 in favour of
        // /v1/subscriptionPlanAvailabilities, which is per plan type (monthly-installment
        // plans); move there when installment plans are needed or the old one stops working.
        const response = await client.post("/v1/subscriptionAvailabilities", {
          data: {
            type: "subscriptionAvailabilities",
            attributes: { availableInNewTerritories },
            relationships: {
              subscription: { data: { type: "subscriptions", id: subscriptionId } },
              availableTerritories: { data: resolved.map((id) => ({ type: "territories", id })) },
            },
          },
        });
        return {
          ...(summarizeResponse(response) as Record<string, unknown>),
          territoryCount: resolved.length,
          availableInNewTerritories,
        };
      }),
  );

  server.registerTool(
    "app_store_connect_create_subscription_introductory_offer",
    {
      title: "App Store Connect: Create Subscription Introductory Offer",
      description:
        "Add an introductory offer for new subscribers: a free trial, or a discounted first " +
        "period. Offers are per territory. A FREE_TRIAL with `territories` omitted is created in " +
        "every territory the subscription is sold in (set availability first). A paid offer " +
        "(PAY_AS_YOU_GO / PAY_UP_FRONT) needs a price point, so it takes exactly one territory " +
        "and its `pricePointId`. Example: a 7-day free trial is offerMode FREE_TRIAL, duration " +
        "ONE_WEEK, numberOfPeriods 1.",
      inputSchema: z.object({
        subscriptionId: subscriptionIdArg,
        offerMode: z.enum(OFFER_MODES),
        duration: z.enum(OFFER_DURATIONS).describe("Length of one offer period."),
        numberOfPeriods: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("How many periods the offer lasts. 1 for a trial or pay-up-front offer."),
        territories: z
          .array(z.string().length(3))
          .optional()
          .describe("Territory codes. Omit for every territory the subscription is sold in."),
        pricePointId: z
          .string()
          .optional()
          .describe("The discounted price point. Required for paid offers; not used by a trial."),
        startDate: z.string().optional().describe('"YYYY-MM-DD". Omit to start now.'),
        endDate: z.string().optional().describe('"YYYY-MM-DD". Omit to run indefinitely.'),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({
      subscriptionId,
      offerMode,
      duration,
      numberOfPeriods,
      territories,
      pricePointId,
      startDate,
      endDate,
    }) =>
      wrap(async () => {
        const isTrial = offerMode === "FREE_TRIAL";
        if (!isTrial && (pricePointId === undefined || territories?.length !== 1)) {
          throw new PreconditionError(
            `A ${offerMode} offer charges a discounted price, which belongs to one territory: ` +
              "pass exactly one territory and its pricePointId (from " +
              "app_store_connect_list_subscription_price_points).",
            { offerMode, territories, pricePointId },
          );
        }
        if (isTrial && pricePointId !== undefined) {
          throw new PreconditionError("A free trial has no price; leave pricePointId out.", {
            offerMode,
            pricePointId,
          });
        }

        let resolved = territories;
        if (resolved === undefined) {
          const availability = await getOrNull(
            client,
            `/v1/subscriptions/${subscriptionId}/subscriptionAvailability`,
          );
          const availabilityId = availability === null ? undefined : resourceOf(availability).id;
          if (typeof availabilityId !== "string") {
            throw new PreconditionError(
              "The subscription isn't available anywhere yet, so there is nowhere to offer a " +
                "trial. Set availability first (app_store_connect_set_subscription_availability) " +
                "or pass `territories`.",
              { subscriptionId },
            );
          }
          resolved = (
            await client.getAll<Rec>(
              `/v1/subscriptionAvailabilities/${availabilityId}/availableTerritories`,
              { limit: 200 },
            )
          ).data.flatMap((t) => (typeof t.id === "string" ? [t.id] : []));
        }

        const results = await inPool(resolved, 4, async (territory) => {
          try {
            await client.post("/v1/subscriptionIntroductoryOffers", {
              data: {
                type: "subscriptionIntroductoryOffers",
                attributes: compact({ offerMode, duration, numberOfPeriods, startDate, endDate }),
                relationships: compact({
                  subscription: { data: { type: "subscriptions", id: subscriptionId } },
                  territory: { data: { type: "territories", id: territory } },
                  subscriptionPricePoint:
                    pricePointId === undefined
                      ? undefined
                      : { data: { type: "subscriptionPricePoints", id: pricePointId } },
                }),
              },
            });
            return { territory, ok: true as const };
          } catch (err) {
            return {
              territory,
              ok: false as const,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        });

        const failed = results.filter((r) => !r.ok);
        return {
          offer: { offerMode, duration, numberOfPeriods },
          territoriesCreated: results.length - failed.length,
          ...(failed.length > 0
            ? {
                failed,
                note:
                  "Some territories failed, often because they already have an offer for these " +
                  "dates. Retry with just those territories.",
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_upload_subscription_review_screenshot",
    {
      title: "App Store Connect: Upload Subscription Review Screenshot",
      description:
        "Attach the review screenshot a subscription needs before submission: a screenshot of " +
        "the purchase inside the app, shown to App Review only. Reserves the asset, uploads, " +
        "commits the checksum and waits for processing. A subscription holds one; uploading " +
        "again replaces it.",
      inputSchema: z.object({
        subscriptionId: subscriptionIdArg,
        filePath: z
          .string()
          .optional()
          .describe("Absolute path to a PNG/JPEG readable BY THIS SERVER."),
        fileData: z
          .string()
          .optional()
          .describe("Base64 image bytes, instead of `filePath`. Requires `fileName`."),
        fileName: z.string().optional().describe("Name to register. Defaults to the file's name."),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(180)
          .default(60)
          .describe("How long to wait for processing (0 = don't wait)."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ subscriptionId, filePath, fileData, fileName, waitSeconds }) =>
      wrap(async () => {
        const { bytes, name } = await readImage(filePath, fileData, fileName, "review screenshot");
        const reserved = await client.post("/v1/subscriptionAppStoreReviewScreenshots", {
          data: {
            type: "subscriptionAppStoreReviewScreenshots",
            attributes: { fileName: name, fileSize: bytes.byteLength },
            relationships: {
              subscription: { data: { type: "subscriptions", id: subscriptionId } },
            },
          },
        });
        const screenshotId = idOf(reserved);
        if (!screenshotId) throw new Error("Reserving the review screenshot returned no id.");
        const ops = envelopeAttributes(reserved).uploadOperations;
        const operations = (Array.isArray(ops) ? ops : []) as UploadOperation[];

        try {
          await client.uploadAsset(operations, bytes);
          await client.patch(`/v1/subscriptionAppStoreReviewScreenshots/${screenshotId}`, {
            data: {
              type: "subscriptionAppStoreReviewScreenshots",
              id: screenshotId,
              attributes: {
                uploaded: true,
                sourceFileChecksum: createHash("md5").update(bytes).digest("hex"),
              },
            },
          });
        } catch (err) {
          // An uncommitted reservation still blocks submission; clear it.
          await client
            .del(`/v1/subscriptionAppStoreReviewScreenshots/${screenshotId}`)
            .catch(() => undefined);
          throw err;
        }

        return pollAssetState(client, {
          resourcePath: "/v1/subscriptionAppStoreReviewScreenshots",
          assetId: screenshotId,
          waitSeconds,
          meta: { subscriptionId, fileName: name, fileSize: bytes.byteLength },
          failureHint:
            "A review screenshot must show the purchase inside your app, at a supported device " +
            "resolution and with no alpha channel.",
          deleteToolName: "app_store_connect_delete_subscription_review_screenshot",
          pollToolName: "app_store_connect_get_subscription_review_screenshot",
        });
      }),
  );

  server.registerTool(
    "app_store_connect_delete_subscription_review_screenshot",
    {
      title: "App Store Connect: Delete Subscription Review Screenshot",
      description:
        "Remove a subscription's review screenshot, e.g. one that failed processing, before " +
        "uploading another. Takes the subscription id and finds the screenshot itself.",
      inputSchema: z.object({ subscriptionId: subscriptionIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ subscriptionId }) =>
      wrap(async () => {
        const screenshotId = idOf(
          await getOrNull(client, `/v1/subscriptions/${subscriptionId}/appStoreReviewScreenshot`),
        );
        if (!screenshotId) {
          return { deleted: null, subscriptionId, note: "No review screenshot was attached." };
        }
        await client.del(`/v1/subscriptionAppStoreReviewScreenshots/${screenshotId}`);
        return { deleted: screenshotId, subscriptionId };
      }),
  );

  server.registerTool(
    "app_store_connect_submit_subscription_for_review",
    {
      title: "App Store Connect: Submit Subscription for Review",
      description:
        "Submit a subscription to Apple for review. It must be READY_TO_SUBMIT (localization, " +
        "price, availability, review screenshot, and a localized group). An app's FIRST " +
        "subscriptions must be reviewed together with an app version: Apple refuses them here " +
        "with a STATE_ERROR, and they are added from the version page's In-App Purchases and " +
        "Subscriptions section in the App Store Connect web UI before submitting the version.",
      inputSchema: z.object({ subscriptionId: subscriptionIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ subscriptionId }) =>
      wrap(async () => {
        const state = attributesOf(
          resourceOf(await client.get(`/v1/subscriptions/${subscriptionId}`)),
        ).state;
        if (state !== "READY_TO_SUBMIT") {
          throw new PreconditionError(
            `This subscription is ${String(state)}, not READY_TO_SUBMIT, so Apple will refuse ` +
              `the submission. MISSING_METADATA means it still needs a localization, a price, ` +
              `availability or a review screenshot, or its group has no localization.`,
            { subscriptionId, state },
          );
        }
        return summarizeResponse(
          await client.post("/v1/subscriptionSubmissions", {
            data: {
              type: "subscriptionSubmissions",
              relationships: {
                subscription: { data: { type: "subscriptions", id: subscriptionId } },
              },
            },
          }),
        );
      }),
  );
};
