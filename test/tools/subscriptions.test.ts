import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { baseConfig, connect, jsonResponse, payloadOf, postCall } from "../helpers.js";

const SUB_ID = "6745000001";
const GROUP_ID = "21500001";
const POINT_USA = "point-usa";

const callTool = async (
  name: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>,
): ReturnType<Client["callTool"]> => {
  const client = await connect(
    { ...baseConfig, allowWrites: true },
    fetchImpl as unknown as typeof fetch,
  );
  return client.callTool({ name, arguments: args });
};

/** The bodies of every POST to `path`, parsed. */
const postBodies = (fetchImpl: ReturnType<typeof vi.fn>, path: string): any[] =>
  fetchImpl.mock.calls
    .filter((c) => String(c[0]).includes(path) && (c[1] as RequestInit)?.method === "POST")
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)));

describe("creating subscriptions", () => {
  it("creates a group linked to the app", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { id: GROUP_ID, type: "subscriptionGroups" } }),
    );
    const result = await callTool(
      "app_store_connect_create_subscription_group",
      { appId: "123", referenceName: "Pro", confirm: true },
      fetchImpl,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(String(postCall(fetchImpl, "/v1/subscriptionGroups")?.[1].body));
    expect(body.data).toEqual({
      type: "subscriptionGroups",
      attributes: { referenceName: "Pro" },
      relationships: { app: { data: { type: "apps", id: "123" } } },
    });
  });

  it("creates a subscription in its group with the period", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { id: SUB_ID, type: "subscriptions" } }),
    );
    await callTool(
      "app_store_connect_create_subscription",
      {
        groupId: GROUP_ID,
        productId: "com.acme.pro.yearly",
        name: "Pro Yearly",
        subscriptionPeriod: "ONE_YEAR",
        groupLevel: 1,
        confirm: true,
      },
      fetchImpl,
    );
    const body = JSON.parse(String(postCall(fetchImpl, "/v1/subscriptions")?.[1].body));
    expect(body.data.attributes).toEqual({
      name: "Pro Yearly",
      productId: "com.acme.pro.yearly",
      subscriptionPeriod: "ONE_YEAR",
      groupLevel: 1,
    });
    // The relationship is `group`, not `subscriptionGroup`.
    expect(body.data.relationships.group.data).toEqual({
      type: "subscriptionGroups",
      id: GROUP_ID,
    });
  });

  it("refuses an over-length display name before calling Apple", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: {} }));
    const result = await callTool(
      "app_store_connect_create_subscription_localization",
      { subscriptionId: SUB_ID, locale: "en-US", name: "x".repeat(31), confirm: true },
      fetchImpl,
    );
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("creates a lifetime in-app purchase", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { id: "iap-1", type: "inAppPurchases" } }),
    );
    await callTool(
      "app_store_connect_create_in_app_purchase",
      {
        appId: "123",
        productId: "com.acme.lifetime",
        name: "Lifetime",
        inAppPurchaseType: "NON_CONSUMABLE",
        confirm: true,
      },
      fetchImpl,
    );
    const body = JSON.parse(String(postCall(fetchImpl, "/v2/inAppPurchases")?.[1].body));
    expect(body.data.attributes).toEqual({
      name: "Lifetime",
      productId: "com.acme.lifetime",
      inAppPurchaseType: "NON_CONSUMABLE",
    });
    expect(body.data.relationships.app.data).toEqual({ type: "apps", id: "123" });
  });

  it("requires confirm", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: {} }));
    const result = await callTool(
      "app_store_connect_create_subscription_group",
      { appId: "123", referenceName: "Pro" },
      fetchImpl,
    );
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("subscription pricing", () => {
  const routed = (
    points: unknown[] = [
      {
        id: POINT_USA,
        type: "subscriptionPricePoints",
        attributes: { customerPrice: "39.99", proceeds: "33.99" },
      },
    ],
  ) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return jsonResponse({ data: { id: "price", type: "subscriptionPrices" } });
      if (String(url).includes("/equalizations")) {
        return jsonResponse({
          data: [
            {
              id: "point-gbr",
              type: "subscriptionPricePoints",
              relationships: { territory: { data: { type: "territories", id: "GBR" } } },
            },
            {
              id: "point-jpn",
              type: "subscriptionPricePoints",
              relationships: { territory: { data: { type: "territories", id: "JPN" } } },
            },
          ],
        });
      }
      return jsonResponse({ data: points });
    });

  it("prices the base territory and every equalized one", async () => {
    const fetchImpl = routed();
    const result = await callTool(
      "app_store_connect_set_subscription_price",
      { subscriptionId: SUB_ID, pricePointId: POINT_USA, baseTerritory: "USA", confirm: true },
      fetchImpl,
    );
    expect(result.isError).toBeFalsy();
    const bodies = postBodies(fetchImpl, "/v1/subscriptionPrices");
    const pairs = bodies
      .map((b) => [
        b.data.relationships.territory.data.id,
        b.data.relationships.subscriptionPricePoint.data.id,
      ])
      .toSorted();
    expect(pairs).toEqual([
      ["GBR", "point-gbr"],
      ["JPN", "point-jpn"],
      ["USA", POINT_USA],
    ]);
    for (const b of bodies) {
      expect(b.data.relationships.subscription.data).toEqual({ type: "subscriptions", id: SUB_ID });
      // No startDate given: nothing is sent, so it applies now.
      expect(b.data.attributes).toEqual({});
    }
    expect(payloadOf(result).territoriesPriced).toBe(3);
  });

  it("prices only the base territory when asked", async () => {
    const fetchImpl = routed();
    await callTool(
      "app_store_connect_set_subscription_price",
      {
        subscriptionId: SUB_ID,
        pricePointId: POINT_USA,
        baseTerritory: "USA",
        allTerritories: false,
        confirm: true,
      },
      fetchImpl,
    );
    expect(postBodies(fetchImpl, "/v1/subscriptionPrices")).toHaveLength(1);
  });

  it("refuses a price point from another territory without pricing anything", async () => {
    const fetchImpl = routed([]);
    const result = await callTool(
      "app_store_connect_set_subscription_price",
      { subscriptionId: SUB_ID, pricePointId: POINT_USA, baseTerritory: "USA", confirm: true },
      fetchImpl,
    );
    expect(result.isError).toBe(true);
    expect(postBodies(fetchImpl, "/v1/subscriptionPrices")).toHaveLength(0);
  });

  it("reports territories that failed instead of failing the whole call", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.data.relationships.territory.data.id === "JPN") {
          return new Response(
            JSON.stringify({ errors: [{ status: "409", code: "ENTITY_ERROR", detail: "nope" }] }),
            {
              status: 409,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return jsonResponse({ data: { id: "price" } });
      }
      return routed()(url, init);
    });
    const result = await callTool(
      "app_store_connect_set_subscription_price",
      { subscriptionId: SUB_ID, pricePointId: POINT_USA, baseTerritory: "USA", confirm: true },
      fetchImpl,
    );
    expect(result.isError).toBeFalsy();
    const payload = payloadOf(result);
    expect(payload.territoriesPriced).toBe(2);
    expect((payload.failed as { territory: string }[]).map((f) => f.territory)).toEqual(["JPN"]);
  });
});

describe("introductory offers", () => {
  it("creates a free trial in every territory the subscription is sold in", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ data: { id: "offer" } });
      if (String(url).includes("/availableTerritories")) {
        return jsonResponse({
          data: [
            { id: "USA", type: "territories" },
            { id: "GBR", type: "territories" },
          ],
        });
      }
      return jsonResponse({ data: { id: "avail-1", type: "subscriptionAvailabilities" } });
    });
    const result = await callTool(
      "app_store_connect_create_subscription_introductory_offer",
      { subscriptionId: SUB_ID, offerMode: "FREE_TRIAL", duration: "ONE_WEEK", confirm: true },
      fetchImpl,
    );
    expect(result.isError).toBeFalsy();
    const bodies = postBodies(fetchImpl, "/v1/subscriptionIntroductoryOffers");
    expect(bodies.map((b) => b.data.relationships.territory.data.id).toSorted()).toEqual([
      "GBR",
      "USA",
    ]);
    expect(bodies[0].data.attributes).toEqual({
      offerMode: "FREE_TRIAL",
      duration: "ONE_WEEK",
      numberOfPeriods: 1,
    });
    // A trial has no price point.
    expect(bodies[0].data.relationships.subscriptionPricePoint).toBeUndefined();
  });

  it("refuses a trial before availability is set", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ status: "404", code: "NOT_FOUND" }] }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await callTool(
      "app_store_connect_create_subscription_introductory_offer",
      { subscriptionId: SUB_ID, offerMode: "FREE_TRIAL", duration: "ONE_WEEK", confirm: true },
      fetchImpl,
    );
    expect(result.isError).toBe(true);
    expect(postBodies(fetchImpl, "/v1/subscriptionIntroductoryOffers")).toHaveLength(0);
  });

  it("refuses a paid offer without exactly one territory and a price point", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const result = await callTool(
      "app_store_connect_create_subscription_introductory_offer",
      { subscriptionId: SUB_ID, offerMode: "PAY_UP_FRONT", duration: "ONE_MONTH", confirm: true },
      fetchImpl,
    );
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("subscription availability and submission", () => {
  it("makes a subscription available everywhere when no territories are named", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse({ data: { id: "avail-1", type: "subscriptionAvailabilities" } })
        : jsonResponse({
            data: [
              { id: "USA", type: "territories" },
              { id: "JPN", type: "territories" },
            ],
          }),
    );
    await callTool(
      "app_store_connect_set_subscription_availability",
      { subscriptionId: SUB_ID, confirm: true },
      fetchImpl,
    );
    const body = JSON.parse(
      String(postCall(fetchImpl, "/v1/subscriptionAvailabilities")?.[1].body),
    );
    expect(body.data.relationships.subscription.data).toEqual({
      type: "subscriptions",
      id: SUB_ID,
    });
    expect(body.data.relationships.availableTerritories.data).toEqual([
      { type: "territories", id: "USA" },
      { type: "territories", id: "JPN" },
    ]);
    expect(body.data.attributes.availableInNewTerritories).toBe(true);
  });

  it("refuses to submit a subscription that is still MISSING_METADATA", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { id: SUB_ID, type: "subscriptions", attributes: { state: "MISSING_METADATA" } },
      }),
    );
    const result = await callTool(
      "app_store_connect_submit_subscription_for_review",
      { subscriptionId: SUB_ID, confirm: true },
      fetchImpl,
    );
    expect(result.isError).toBe(true);
    expect(postCall(fetchImpl, "/v1/subscriptionSubmissions")).toBeUndefined();
  });
});
