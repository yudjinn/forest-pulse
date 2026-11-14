// Suspected activities, derived from stored events whenever they are read and never stored themselves. This is the
// merge rule's one place: events of one category, from any sensor, ordered by corrected time, belong to one activity
// while the gap from each event to the next stays under 60 s. A late backlog event lands wherever its time puts it,
// so it can extend an activity or join two. Kept free of Worker types so the focused test imports it directly.

export const MERGE_GAP_MS = 60_000;
export const ACTIVITY_LIMIT = 50;

// The stored event fields grouping reads. occurred_at is the corrected time, in ms since the epoch.
export interface ActivityEvent {
  id: number;
  sensor_id: string;
  sound_name: string;
  category: string;
  occurred_at: number;
}

export interface Activity<E extends ActivityEvent = ActivityEvent> {
  category: string;
  first_at: number;
  last_at: number;
  // Distinct, in the order first heard.
  sounds: string[];
  sensors: string[];
  // Oldest first by corrected time (then by id).
  events: E[];
}

// Groups events (in any order) into activities, newest first by their last event, at most `limit` of them.
export function groupActivities<E extends ActivityEvent>(events: readonly E[], limit = ACTIVITY_LIMIT): Activity<E>[] {
  const sorted = [...events].sort((a, b) => a.occurred_at - b.occurred_at || a.id - b.id);
  const latest = new Map<string, Activity<E>>();
  const all: Activity<E>[] = [];
  for (const e of sorted) {
    let activity = latest.get(e.category);
    if (!activity || e.occurred_at - activity.last_at >= MERGE_GAP_MS) {
      activity = { category: e.category, first_at: e.occurred_at, last_at: e.occurred_at, sounds: [], sensors: [], events: [] };
      latest.set(e.category, activity);
      all.push(activity);
    }
    activity.last_at = e.occurred_at;
    activity.events.push(e);
    if (!activity.sounds.includes(e.sound_name)) activity.sounds.push(e.sound_name);
    if (!activity.sensors.includes(e.sensor_id)) activity.sensors.push(e.sensor_id);
  }
  const lastId = (a: Activity<E>) => a.events[a.events.length - 1].id;
  return all.sort((a, b) => b.last_at - a.last_at || lastId(b) - lastId(a)).slice(0, limit);
}
