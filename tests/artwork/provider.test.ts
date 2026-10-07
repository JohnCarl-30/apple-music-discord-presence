import { describe, expect, it, vi } from "vitest";
import { CachingArtworkProvider } from "../../src/artwork/provider.js";

const DAY = 86_400_000;

describe("CachingArtworkProvider", () => {
  it("returns the looked-up URL", async () => {
    const lookup = vi.fn().mockResolvedValue("https://art/1.jpg");
    const provider = new CachingArtworkProvider({ lookup });
    await expect(provider.get("NIKI", "Nicole")).resolves.toBe("https://art/1.jpg");
  });

  it("serves a repeat request from cache", async () => {
    const lookup = vi.fn().mockResolvedValue("https://art/1.jpg");
    const provider = new CachingArtworkProvider({ lookup });
    await provider.get("NIKI", "Nicole");
    await provider.get("NIKI", "Nicole");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("treats differently-spelled keys as the same entry", async () => {
    const lookup = vi.fn().mockResolvedValue("https://art/1.jpg");
    const provider = new CachingArtworkProvider({ lookup });
    await provider.get("NIKI", "Nicole");
    await provider.get("  niki ", "nicole!");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("caches misses so a non-catalog album is not re-queried", async () => {
    const lookup = vi.fn().mockResolvedValue(null);
    const provider = new CachingArtworkProvider({ lookup });
    await expect(provider.get("Local", "Bootleg")).resolves.toBeNull();
    await expect(provider.get("Local", "Bootleg")).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("re-queries after the TTL expires", async () => {
    let clock = 0;
    const lookup = vi.fn().mockResolvedValue("https://art/1.jpg");
    const provider = new CachingArtworkProvider({ lookup, ttlMs: DAY, now: () => clock });
    await provider.get("NIKI", "Nicole");
    clock = DAY - 1;
    await provider.get("NIKI", "Nicole");
    expect(lookup).toHaveBeenCalledTimes(1);
    clock = DAY + 1;
    await provider.get("NIKI", "Nicole");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("does not cache distinct albums together", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce("https://art/1.jpg")
      .mockResolvedValueOnce("https://art/2.jpg");
    const provider = new CachingArtworkProvider({ lookup });
    await expect(provider.get("A", "One")).resolves.toBe("https://art/1.jpg");
    await expect(provider.get("A", "Two")).resolves.toBe("https://art/2.jpg");
  });

  it("collapses concurrent requests for the same key into one lookup", async () => {
    let release: (v: string) => void = () => {};
    const lookup = vi.fn().mockReturnValue(new Promise<string>((r) => (release = r)));
    const provider = new CachingArtworkProvider({ lookup });
    const a = provider.get("NIKI", "Nicole");
    const b = provider.get("NIKI", "Nicole");
    release("https://art/1.jpg");
    await expect(Promise.all([a, b])).resolves.toEqual([
      "https://art/1.jpg",
      "https://art/1.jpg",
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("returns null and does not poison the cache when the lookup throws", async () => {
    const lookup = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("https://art/1.jpg");
    const provider = new CachingArtworkProvider({ lookup });
    await expect(provider.get("NIKI", "Nicole")).resolves.toBeNull();
    await expect(provider.get("NIKI", "Nicole")).resolves.toBe("https://art/1.jpg");
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
