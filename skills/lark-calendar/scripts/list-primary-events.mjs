#!/usr/bin/env node
import { parseArgs } from 'util';
import { larkApi } from '../lib/lark-api.mjs';
import { listEvents, timestampToDatetime, DEFAULT_TIMEZONE } from '../lib/calendar.mjs';

const { values } = parseArgs({
  options: {
    start: { type: 'string' },
    end: { type: 'string' },
    timezone: { type: 'string', default: DEFAULT_TIMEZONE },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }
  }
});

if (values.help) {
  console.log('Usage: node skills/lark-calendar/scripts/list-primary-events.mjs [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--timezone Asia/Shanghai] [--json]');
  process.exit(0);
}

const calendars = await larkApi('GET', '/calendar/v4/calendars');
const primary = (calendars.calendar_list || []).find(c => c.type === 'primary') || calendars.calendar_list?.[0];
if (!primary) {
  console.error('No calendar found');
  process.exit(1);
}

const events = await listEvents({
  calendarId: primary.calendar_id,
  startTime: values.start,
  endTime: values.end,
  timezone: values.timezone
});

if (values.json) {
  console.log(JSON.stringify({ calendar: primary, events }, null, 2));
  process.exit(0);
}

console.log(`Calendar: ${primary.summary} (${primary.calendar_id})`);
if (!events.length) {
  console.log('No events found.');
  process.exit(0);
}
for (const event of events) {
  const startTime = event.start_time?.timestamp ? timestampToDatetime(parseInt(event.start_time.timestamp), values.timezone) : 'N/A';
  const endTime = event.end_time?.timestamp ? timestampToDatetime(parseInt(event.end_time.timestamp), values.timezone) : 'N/A';
  console.log(`- ${event.summary || '(No title)'} | ${startTime} -> ${endTime}`);
}
