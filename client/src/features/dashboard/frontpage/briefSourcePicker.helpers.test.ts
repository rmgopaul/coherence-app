import { describe, expect, it } from "vitest";

import type { CalendarEvent, GmailMessage, TodoistTask } from "../types";
import {
  calendarBriefSourceOptions,
  clockifyBriefSourceOptions,
  dailyBriefSourceOptions,
  dockBriefSourceOptions,
  driveBriefSourceOptions,
  gmailBriefSourceOptions,
  healthBriefSourceOptions,
  newsBriefSourceOptions,
  sourceRefPatchFromPickerOption,
  systemBriefSourceOptions,
  todayPlanBriefSourceOptions,
  todoistBriefSourceOptions,
  weatherBriefSourceOptions,
  weeklyReviewBriefSourceOptions,
} from "./briefSourcePicker.helpers";

describe("brief source picker helpers", () => {
  it("builds meaningful Todoist source options from due-today tasks", () => {
    const options = todoistBriefSourceOptions([
      {
        id: "task-1",
        content: "Send proposal",
        description: "",
        projectId: "project-1",
        priority: 4,
        labels: [],
      },
    ] as TodoistTask[]);

    expect(options).toEqual([
      {
        key: "todoist:task-1",
        source: "todoist",
        id: "task-1",
        label: "Send proposal",
        url: "https://todoist.com/showTask?id=task-1",
        display: "Send proposal",
      },
    ]);
  });

  it("builds Gmail options from recent message subject lines", () => {
    const options = gmailBriefSourceOptions([
      {
        id: "msg-1",
        threadId: "thread-1",
        snippet: "Please review",
        internalDate: "1760000000000",
        payload: {
          headers: [
            { name: "From", value: "Client <client@example.com>" },
            { name: "Subject", value: "Contract review" },
          ],
        },
      },
    ] as GmailMessage[]);

    expect(options[0]).toMatchObject({
      key: "gmail:thread-1",
      source: "gmail",
      id: "thread-1",
      label: "Contract review",
      url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
      display: "Contract review - Client <client@example.com>",
    });
  });

  it("keeps calendar options within the next six months", () => {
    const now = new Date("2026-05-17T12:00:00.000Z");
    const options = calendarBriefSourceOptions(
      [
        {
          id: "event-1",
          summary: "Pipeline review",
          htmlLink: "https://calendar.google.com/event?eid=event-1",
          start: { dateTime: "2026-06-01T15:00:00.000Z" },
        },
        {
          id: "event-2",
          summary: "Too far away",
          start: { dateTime: "2026-12-01T15:00:00.000Z" },
        },
      ] as CalendarEvent[],
      now
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      key: "calendar:event-1",
      source: "calendar",
      id: "event-1",
      label: "Pipeline review",
      url: "https://calendar.google.com/event?eid=event-1",
    });
    expect(options[0].display).toContain("Pipeline review - ");
  });

  it("converts selected options into stored source refs without leaking display-only text", () => {
    expect(
      sourceRefPatchFromPickerOption({
        key: "gmail:thread-1",
        source: "gmail",
        id: "thread-1",
        label: "Contract review",
        url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
        display: "Contract review - Client <client@example.com>",
      })
    ).toEqual({
      id: "thread-1",
      label: "Contract review",
      url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
    });
  });

  it("builds source-specific options for dock and Drive items", () => {
    expect(
      dockBriefSourceOptions([
        {
          id: "dock-1",
          source: "todoist",
          title: "Review pitch deck",
          url: "https://todoist.com/showTask?id=123",
          meta: {},
          pinnedAt: "2026-05-17T12:00:00.000Z",
          createdAt: "2026-05-17T12:00:00.000Z",
          dueAt: null,
          x: null,
          y: null,
          tilt: null,
          color: null,
        },
      ] as any)
    ).toMatchObject([
      {
        key: "dock:dock-1",
        source: "dock",
        id: "dock-1",
        label: "Review pitch deck",
        url: "https://todoist.com/showTask?id=123",
      },
    ]);

    expect(
      driveBriefSourceOptions([
        {
          id: "file-1",
          name: "Q2 priorities",
          webViewLink: "https://drive.google.com/file/d/file-1/view",
          modifiedTime: "2026-05-17T12:00:00.000Z",
        },
      ] as any)
    ).toMatchObject([
      {
        key: "drive:file-1",
        source: "drive",
        id: "file-1",
        label: "Q2 priorities",
        url: "https://drive.google.com/file/d/file-1/view",
      },
    ]);
  });

  it("builds workflow-local options for daily brief and today plan", () => {
    expect(
      dailyBriefSourceOptions(
        {
          headline: "Protect focus time",
          summary: "One deep-work block before meetings.",
          generatedAt: "2026-05-17T12:00:00.000Z",
          sourceRefs: [],
        },
        "2026-05-17"
      ).map((option) => option.label)
    ).toEqual(["Protect focus time", "Daily brief summary"]);

    expect(
      todayPlanBriefSourceOptions({
        topPriority: "Finish board memo",
        notes: null,
        updatedAt: null,
        blocks: [
          {
            id: "block-1",
            title: "Draft board memo",
            startIso: "2026-05-17T15:00:00.000Z",
            endIso: null,
            source: "system",
            sourceId: null,
            status: "planned",
          },
        ],
      }).map((option) => option.label)
    ).toEqual(["Finish board memo", "Draft board memo"]);
  });

  it("builds curated options for weekly review, health, weather, news, system, and Clockify", () => {
    const commandCenter = {
      dateKey: "2026-05-17",
      rightNow: {
        title: "Send investor update",
        kind: "todoist",
        sourceId: "task-1",
        sourceUrl: "https://todoist.com/showTask?id=task-1",
        reason: "Highest-priority task due today.",
      },
      metrics: {
        tasksDueToday: 3,
        tasksCompletedToday: 1,
        meetingsRemaining: 2,
        inboxToTriage: 4,
        waitingOnCount: 1,
        dockReminderCount: 0,
        activeDockCount: 2,
      },
      weeklyReview: {
        headline: "Momentum improved",
        weekKey: "2026-W20",
        status: "ready",
        generatedAt: "2026-05-17T12:00:00.000Z",
      },
      sourceFreshness: [
        {
          source: "samsungHealth",
          status: "connected",
          fetchedAt: "2026-05-17T12:00:00.000Z",
          detail: "Synced today",
        },
      ],
      integrations: [
        {
          key: "google",
          label: "Google",
          status: "connected",
          reason: null,
          connected: true,
          lastSeenAt: "2026-05-17T12:00:00.000Z",
          actionHref: "/settings",
        },
      ],
    } as any;

    expect(
      weeklyReviewBriefSourceOptions(null, commandCenter)[0]
    ).toMatchObject({
      source: "weekly_review",
      id: "2026-W20",
      label: "Momentum improved",
    });

    expect(
      healthBriefSourceOptions(
        {
          dataDate: "2026-05-17",
          updatedAt: "2026-05-17T12:00:00.000Z",
          recoveryScore: 71,
          sleepHours: 7.4,
          dayStrain: 8.2,
        } as any,
        commandCenter
      ).map((option) => option.source)
    ).toEqual(["health", "whoop", "samsungHealth"]);

    expect(
      weatherBriefSourceOptions({
        offline: false,
        label: "Home",
        tempF: 72,
        description: "clear sky",
        fetchedAt: "2026-05-17T12:00:00.000Z",
      } as any)[0]
    ).toMatchObject({
      source: "weather",
      label: "Weather in Home",
    });

    expect(
      newsBriefSourceOptions({
        reason: "ok",
        items: [
          {
            src: "AP",
            title: "Market update",
            url: "https://example.com/news",
            publishedAt: "2026-05-17T12:00:00.000Z",
          },
        ],
      })[0]
    ).toMatchObject({
      source: "news",
      label: "Market update",
      url: "https://example.com/news",
    });

    expect(systemBriefSourceOptions(commandCenter)[0]).toMatchObject({
      source: "system",
      label: "Send investor update",
    });

    expect(
      clockifyBriefSourceOptions(
        { connected: true, workspaceId: "workspace-1", workspaceName: "Ops" } as any,
        null,
        [
          {
            id: "entry-1",
            description: "Pipeline cleanup",
            projectName: "Ops",
            start: "2026-05-17T12:00:00.000Z",
          },
        ] as any
      )[0]
    ).toMatchObject({
      source: "clockify",
      id: "entry-1",
      label: "Pipeline cleanup",
    });
  });
});
