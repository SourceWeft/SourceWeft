export type BillingCycleWindow = {
  startAt: Date;
  endAt: Date;
};

const MIN_ANCHOR_DAY = 1;
const MAX_ANCHOR_DAY = 28;

function normalizeAnchorDay(anchorDay: number) {
  if (!Number.isFinite(anchorDay)) {
    return MIN_ANCHOR_DAY;
  }

  const rounded = Math.floor(anchorDay);
  return Math.min(MAX_ANCHOR_DAY, Math.max(MIN_ANCHOR_DAY, rounded));
}

function daysInUtcMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function buildUtcDate(year: number, month: number, day: number) {
  const safeDay = Math.min(day, daysInUtcMonth(year, month));
  return new Date(Date.UTC(year, month, safeDay, 0, 0, 0, 0));
}

function shiftUtcMonth(year: number, month: number, delta: number) {
  const rawMonth = month + delta;
  const nextYear = year + Math.floor(rawMonth / 12);
  let nextMonth = rawMonth % 12;

  if (nextMonth < 0) {
    nextMonth += 12;
  }

  return {
    year: nextYear,
    month: nextMonth,
  };
}

export function getMonthlyCycleWindow(
  now: Date,
  anchorDay = 1,
): BillingCycleWindow {
  const safeAnchorDay = normalizeAnchorDay(anchorDay);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const thisMonthStart = buildUtcDate(year, month, safeAnchorDay);

  if (now >= thisMonthStart) {
    const nextMonth = shiftUtcMonth(year, month, 1);
    return {
      startAt: thisMonthStart,
      endAt: buildUtcDate(nextMonth.year, nextMonth.month, safeAnchorDay),
    };
  }

  const prevMonth = shiftUtcMonth(year, month, -1);
  return {
    startAt: buildUtcDate(prevMonth.year, prevMonth.month, safeAnchorDay),
    endAt: thisMonthStart,
  };
}
