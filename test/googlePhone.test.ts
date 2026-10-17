// The phone's backup Google sign-in (docs/PLAN.md phase 7): when the phone uses Google,
// where its tokens come from, and which queued Schedule changes it may send.
import { afterEach, describe, expect, it } from "vitest";
import { saveCredential } from "../src/core/credentials.ts";
import { migrate } from "../src/core/db/schema.ts";
import type { Db } from "../src/core/db/types.ts";
import { google } from "../src/core/google/integration.ts";
import {
  googleAccessToken, googleActiveHere, NativeGoogleConsentNeeded, setNativeGoogleAuthorizer, type GoogleCredential,
} from "../src/core/google/token.ts";
import { SignedOutError } from "../src/core/integration.ts";
import { saveTask } from "../src/core/schedule/edit.ts";
import type { GoogleTask, ScheduleGoogle } from "../src/core/schedule/googleApi.ts";
import { pushChanges, unsentOwnChanges } from "../src/core/schedule/push.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

const PHONE: GoogleCredential = { android: true };
const DESKTOP: GoogleCredential = { clientId: "id", clientSecret: "secret", refreshToken: "refresh" };
const NOW = new Date("2026-10-17T15:00:00Z");

async function newDb(): Promise<Db> {
  const db = openNodeDb(":memory:");
  await migrate(db);
  await db.run(
    "INSERT INTO task_list (id, updated_at, updated_by, deleted, seq, title, position) VALUES ('list1', '2026-01-01', 'x', 0, 0, 'My Tasks', 0)",
  );
  return db;
}

/** Records a sync with a desktop: when, and how far this device's changes were sent. */
async function syncedWithDesktop(db: Db, at: string, sentSeq = 0) {
  await db.run("INSERT OR REPLACE INTO sync_peer (peer_id, sent_seq, received_seq, last_synced_at) VALUES ('desktop', ?, 0, ?)", [sentSeq, at]);
}

afterEach(() => setNativeGoogleAuthorizer(null));

describe("when the phone uses Google", () => {
  it("leaves Google to the desktop until they haven't synced for 12 hours", async () => {
    const db = await newDb();
    expect(await googleActiveHere(db, PHONE, NOW)).toBe(true); // never synced: on its own
    await syncedWithDesktop(db, "2026-10-17T05:00:00Z"); // 10 hours ago
    expect(await googleActiveHere(db, PHONE, NOW)).toBe(false);
    await syncedWithDesktop(db, "2026-10-17T03:00:00Z"); // 12 hours ago
    expect(await googleActiveHere(db, PHONE, NOW)).toBe(true);
    expect(await googleActiveHere(db, DESKTOP, NOW)).toBe(true); // the desktop always does
  });

  it("does nothing at an update while the desktop is in reach", async () => {
    const db = await newDb();
    await saveCredential(db, "google", PHONE);
    await syncedWithDesktop(db, new Date().toISOString());
    let asked = 0;
    setNativeGoogleAuthorizer(async () => {
      asked++;
      return "token";
    });
    expect(await google.update(db)).toEqual([]);
    expect(asked).toBe(0);
  });
});

describe("where tokens come from", () => {
  it("asks Android on the phone, without showing anything during updates", async () => {
    const requests: [string[], boolean][] = [];
    setNativeGoogleAuthorizer(async (scopes, interactive) => {
      requests.push([scopes, interactive]);
      return "android-token";
    });
    expect(await googleAccessToken(PHONE, ["scope-a"])).toBe("android-token");
    expect(requests).toEqual([[["scope-a"], false]]);
  });

  it("reports signed out when Android needs the user to agree again", async () => {
    setNativeGoogleAuthorizer(async () => {
      throw new NativeGoogleConsentNeeded("consent");
    });
    await expect(googleAccessToken(PHONE, ["scope-a"])).rejects.toBeInstanceOf(SignedOutError);
  });
});

describe("which queued changes the phone sends", () => {
  /** A pretend Google that only takes new tasks. */
  function fakeTasks() {
    const inserted: string[] = [];
    const google = {
      async insertTask(_listId: string, task: GoogleTask) {
        inserted.push(task.title!);
        return { ...task, id: `g-${task.title}`, etag: `e-${task.title}` };
      },
    } as unknown as ScheduleGoogle;
    return { google, inserted };
  }

  it("sends only its own changes not yet handed to the desktop", async () => {
    const db = await newDb();
    const task = (title: string) => saveTask(db, { title, notes: "", date: "2026-10-18", time: null, repeat: null });
    await task("Handed to the desktop");
    const handedUpTo = Number((await db.all("SELECT MAX(seq) AS seq FROM schedule_change"))[0].seq);
    await syncedWithDesktop(db, "2026-10-16T09:00:00Z", handedUpTo);
    await task("Made while away");
    // A change that arrived from the desktop (another device's) is the desktop's to send.
    const fromDesktop = await task("From the desktop");
    await db.run("UPDATE schedule_change SET updated_by = 'desktop-device' WHERE op LIKE ?", [`%${fromDesktop}%`]);

    const { google, inserted } = fakeTasks();
    await pushChanges(db, google, await unsentOwnChanges(db));
    expect(inserted).toEqual(["Made while away"]);
    // The others stay queued for the desktop.
    expect((await db.all("SELECT 1 FROM schedule_change WHERE deleted = 0")).length).toBe(2);
  });
});
