// Focused test of the activity merge rule (no browser, no service): events of one category merge while the gap
// to the next stays under 60 s by corrected time, wherever and whenever they arrive.
import { expect, test } from "@playwright/test";
import { ACTIVITY_LIMIT, type ActivityEvent, groupActivities, MERGE_GAP_MS } from "../../src/activities/group.ts";

const T0 = Date.UTC(2026, 10, 15, 10, 0, 0);
let nextId = 1;
function ev(category: string, at: number, sound = "Chainsaw", sensor = "a"): ActivityEvent {
  return { id: nextId++, sensor_id: sensor, sound_name: sound, category, occurred_at: T0 + at };
}

test("a gap just under 60 s merges and a gap of exactly 60 s starts a new activity", () => {
  const merged = groupActivities([ev("logging", 0), ev("logging", MERGE_GAP_MS - 1)]);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ first_at: T0, last_at: T0 + MERGE_GAP_MS - 1 });

  const split = groupActivities([ev("logging", 0), ev("logging", MERGE_GAP_MS)]);
  expect(split.map((a) => a.first_at)).toEqual([T0 + MERGE_GAP_MS, T0]);

  // The gap is measured from the previous event, not from the activity's start: a chain keeps one activity going.
  const chain = groupActivities([0, 50, 100, 150].map((s) => ev("logging", s * 1000)));
  expect(chain).toHaveLength(1);
  expect(chain[0].events).toHaveLength(4);
});

test("categories never merge, and sounds and sensors are listed once each in the order heard", () => {
  const activities = groupActivities([
    ev("logging", 0, "Chainsaw", "hall-a"),
    ev("vehicle", 5_000, "Vehicle", "hall-b"),
    ev("logging", 10_000, "Tools", "hall-b"),
    ev("logging", 20_000, "Chainsaw", "hall-a"),
  ]);
  expect(activities.map((a) => a.category)).toEqual(["logging", "vehicle"]);
  expect(activities[0]).toMatchObject({ sounds: ["Chainsaw", "Tools"], sensors: ["hall-a", "hall-b"] });
  expect(activities[0].events).toHaveLength(3);
  expect(activities[1]).toMatchObject({ sounds: ["Vehicle"], sensors: ["hall-b"], first_at: T0 + 5_000 });
});

test("a late backlog event is placed by its corrected time, extending or joining activities", () => {
  const early = ev("logging", 0);
  const later = ev("logging", 100_000);
  expect(groupActivities([early, later])).toHaveLength(2);
  // Delivered last (highest id), but its time falls between the two: it joins them into one.
  const backlog = ev("logging", 50_000, "Power tool", "b");
  const joined = groupActivities([early, later, backlog]);
  expect(joined).toHaveLength(1);
  expect(joined[0]).toMatchObject({ first_at: T0, last_at: T0 + 100_000, sounds: ["Chainsaw", "Power tool"] });
  expect(joined[0].events.map((e) => e.id)).toEqual([early.id, backlog.id, later.id]);
});

test("activities come newest first by their last event, at most 50", () => {
  const events = Array.from({ length: ACTIVITY_LIMIT + 5 }, (_, i) => ev("wildlife", i * MERGE_GAP_MS * 2));
  const activities = groupActivities(events);
  expect(activities).toHaveLength(ACTIVITY_LIMIT);
  expect(activities[0].last_at).toBe(events[events.length - 1].occurred_at);
  expect(activities[ACTIVITY_LIMIT - 1].last_at).toBe(events[5].occurred_at);
  // An activity that started earlier but heard something more recently comes first.
  const order = groupActivities([ev("logging", 0), ev("vehicle", 10_000), ev("logging", 30_000)]);
  expect(order.map((a) => a.category)).toEqual(["logging", "vehicle"]);
});
