import { describe, expect, it } from "vitest";
import { resolveKingHeadlineHref } from "./kingHeadlineLink";

describe("resolveKingHeadlineHref", () => {
  it("returns null for a null/undefined king", () => {
    expect(resolveKingHeadlineHref(null)).toBeNull();
    expect(resolveKingHeadlineHref(undefined)).toBeNull();
  });

  it("returns null when neither taskId nor eventId is set", () => {
    expect(
      resolveKingHeadlineHref({ taskId: null, eventId: null })
    ).toBeNull();
    expect(
      resolveKingHeadlineHref({ taskId: "", eventId: "" })
    ).toBeNull();
  });

  describe("taskId branch", () => {
    it("returns the Todoist web URL for a non-empty taskId", () => {
      expect(
        resolveKingHeadlineHref({ taskId: "12345", eventId: null })
      ).toBe("https://todoist.com/app/task/12345");
    });

    it("trims surrounding whitespace before building the URL", () => {
      expect(
        resolveKingHeadlineHref({ taskId: "  abc-1  ", eventId: null })
      ).toBe("https://todoist.com/app/task/abc-1");
    });

    it("URL-encodes the taskId so unusual IDs don't break the URL", () => {
      // Todoist IDs are normally numeric/alphanum, but the encoder is
      // a defense-in-depth move — we don't trust the value.
      expect(
        resolveKingHeadlineHref({ taskId: "ab/cd?ef", eventId: null })
      ).toBe("https://todoist.com/app/task/ab%2Fcd%3Fef");
    });

    it("prefers taskId over eventId when both are set", () => {
      expect(
        resolveKingHeadlineHref(
          { taskId: "t-1", eventId: "e-1" },
          [{ id: "e-1", htmlLink: "https://calendar.example/e-1" }]
        )
      ).toBe("https://todoist.com/app/task/t-1");
    });
  });

  describe("eventId branch", () => {
    it("returns the matching event's htmlLink", () => {
      expect(
        resolveKingHeadlineHref(
          { taskId: null, eventId: "evt-42" },
          [
            { id: "evt-1", htmlLink: "https://calendar.example/1" },
            {
              id: "evt-42",
              htmlLink: "https://calendar.example/42",
            },
            { id: "evt-99", htmlLink: "https://calendar.example/99" },
          ]
        )
      ).toBe("https://calendar.example/42");
    });

    it("returns null when no event matches", () => {
      expect(
        resolveKingHeadlineHref(
          { taskId: null, eventId: "evt-missing" },
          [{ id: "evt-1", htmlLink: "https://calendar.example/1" }]
        )
      ).toBeNull();
    });

    it("returns null when calendarEvents is empty", () => {
      expect(
        resolveKingHeadlineHref(
          { taskId: null, eventId: "evt-1" },
          []
        )
      ).toBeNull();
    });

    it("returns null when the matching event has no htmlLink", () => {
      expect(
        resolveKingHeadlineHref(
          { taskId: null, eventId: "evt-1" },
          [{ id: "evt-1", htmlLink: null }]
        )
      ).toBeNull();
    });

    it("returns null when the matching event's htmlLink is whitespace-only", () => {
      expect(
        resolveKingHeadlineHref(
          { taskId: null, eventId: "evt-1" },
          [{ id: "evt-1", htmlLink: "   " }]
        )
      ).toBeNull();
    });

    it("matches eventId by exact string (no loose equality)", () => {
      expect(
        resolveKingHeadlineHref(
          { taskId: null, eventId: "123" },
          [{ id: "1234", htmlLink: "https://calendar.example/1234" }]
        )
      ).toBeNull();
    });

    it("trims eventId whitespace before matching", () => {
      expect(
        resolveKingHeadlineHref(
          { taskId: null, eventId: "  evt-1  " },
          [{ id: "evt-1", htmlLink: "https://calendar.example/1" }]
        )
      ).toBe("https://calendar.example/1");
    });
  });

  describe("defensive shape handling", () => {
    it("ignores non-string taskId values", () => {
      expect(
        resolveKingHeadlineHref({
          taskId: 123 as unknown as string,
          eventId: "evt-1",
        })
      ).toBeNull();
    });

    it("ignores non-string eventId values", () => {
      expect(
        resolveKingHeadlineHref({
          taskId: null,
          eventId: 99 as unknown as string,
        })
      ).toBeNull();
    });

    it("ignores calendarEvents with non-string id", () => {
      expect(
        resolveKingHeadlineHref(
          { taskId: null, eventId: "evt-1" },
          [
            {
              id: 123 as unknown as string,
              htmlLink: "https://calendar.example/1",
            },
          ]
        )
      ).toBeNull();
    });
  });
});
