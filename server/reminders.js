import { store } from './store.js';
import { bus } from './bus.js';

// Promotes pending reminders to "due" and tells the browser. Runs inside the
// server process, so a reminder only fires while JARVIS is running.
export function startReminderClock() {
  const tick = () => {
    const now = Date.now();
    for (const r of store.data.reminders) {
      if (r.status === 'pending' && new Date(r.at).getTime() <= now) {
        r.status = 'due';
        r.dueAt = new Date().toISOString();
        store.save();
        bus.publish('reminder.due', r);
        bus.publish('refresh', { panels: ['reminders'] });
      }
    }
  };
  tick();
  return setInterval(tick, 5000);
}
