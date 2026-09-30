import { afterEach, describe, expect, test, vi } from "bun:test";
import { loginCursorHook, refreshCursorHook } from "../../../src/registry/oauth/cursor";

const tokenFor = (id: string) => `header.${btoa(JSON.stringify({ sub: `auth0|${id}`, exp: 2_000_000_000 }))}.signature`;

afterEach(() => vi.restoreAllMocks());

function mockFetch(implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }));
}

describe("Cursor OAuth account identity", () => {
	test("browser login saves the verified profile email for account selection", async () => {
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const access = tokenFor("user-1");
		const fetchSpy = mockFetch(async input => {
			if (String(input).includes("/auth/poll?")) {
				return Response.json({ accessToken: access, refreshToken: "refresh-1" });
			}
			return Response.json({ sub: "user-1", email: " first@example.com " });
		});
		const credentials = await loginCursorHook({ onAuth: () => {}, onPrompt: async () => "" });
		expect(credentials).toMatchObject({ accountId: "user-1", email: "first@example.com" });
		const profileRequest = fetchSpy.mock.calls.find(call => String(call[0]).endsWith("/api/auth/me"));
		expect(profileRequest?.[1]?.headers).toMatchObject({
			Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`user-1::${access}`)}`,
		});
	});

	test("refresh backfills email for an older credential without identity", async () => {
		const access = tokenFor("user-1");
		mockFetch(async input =>
			String(input).includes("exchange_user_api_key")
				? Response.json({ accessToken: access, refreshToken: "rotated" })
				: Response.json({ sub: "user-1", email: "first@example.com" }),
		);
		expect(await refreshCursorHook({ access, refresh: "old", expires: 0 })).toMatchObject({
			access,
			refresh: "rotated",
			accountId: "user-1",
			email: "first@example.com",
		});
	});

	test("a mismatched profile cannot relabel the account and refresh retains its known email", async () => {
		const access = tokenFor("user-1");
		mockFetch(async input =>
			String(input).includes("exchange_user_api_key")
				? Response.json({ accessToken: access })
				: Response.json({ sub: "user-2", email: "other@example.com" }),
		);
		expect(await refreshCursorHook({ access, refresh: "old", expires: 0, email: "first@example.com" })).toMatchObject(
			{
				refresh: "old",
				accountId: "user-1",
				email: "first@example.com",
			},
		);
	});

	test("optional profile failures do not invalidate a successful token refresh", async () => {
		const access = tokenFor("user-1");
		mockFetch(async input => {
			if (String(input).includes("exchange_user_api_key")) return Response.json({ accessToken: access });
			throw new Error("dashboard unavailable");
		});
		expect(await refreshCursorHook({ access, refresh: "old", expires: 0 })).toMatchObject({
			access,
			accountId: "user-1",
		});
	});
});
