const FACTOR = 100000000n;
const CATEGORIES = ['code', 'tests', 'documentation', 'configuration'];

export function formatTicks(value, separator = ',') {
  if (value === null || value === undefined) return '—';
  const number = BigInt(value);
  const sign = number < 0n ? '-' : '';
  const absolute = number < 0n ? -number : number;
  const fraction = (absolute % FACTOR).toString().padStart(8, '0').replace(/0+$/, '');
  return `${sign}${absolute / FACTOR}${fraction ? separator + fraction : ''}`;
}

function dates(from, to) {
  for (const value of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Укажите корректные даты периода');
  }
  if (from > to) throw new Error('Начало периода позже окончания');
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if ((end - start) / 86400000 > 3660) throw new Error('Выберите период не длиннее 3660 дней');
  const result = [];
  for (const day = start; day <= end; day.setUTCDate(day.getUTCDate() + 1)) result.push(day.toISOString().slice(0, 10));
  return result;
}

function coverageStatuses(data, projects, day, today) {
  if (day === today) return ['current_day'];
  if (day > today) return ['future_day'];
  const statuses = new Set();
  for (const project of projects) {
    const value = data.coverage[project];
    const attempt = value?.last_attempt ?? {};
    if (attempt.from <= day && day <= attempt.to && !attempt.list_complete) statuses.add('collection_failed');
    else if (!value?.confirmed_ranges.some((row) => row.from <= day && day <= row.to)) statuses.add('not_collected');
    else statuses.add('complete');
  }
  return [...statuses].sort();
}

export function coverageLabel(statuses) {
  const names = { current_day: 'Текущий день не завершён', future_day: 'Будущий день', not_collected: 'Период не собран', collection_failed: 'Ошибка загрузки списка MR', complete: 'Подтверждено' };
  const selected = statuses.some((status) => status !== 'complete') ? statuses.filter((status) => status !== 'complete') : statuses;
  return selected.map((status) => names[status]).join(' · ');
}

function summarize(data, records, people, projects, days, today) {
  const coverage = [...new Set(days.flatMap((day) => coverageStatuses(data, projects, day, today)))].sort();
  const completeCoverage = coverage.every((status) => status === 'complete');
  const keys = new Set(), newKeys = new Set(), repeats = new Set(), pending = new Set();
  const missingNeural = new Set(), missingSelected = new Set(), manual = new Set();
  let neural = 0n, selected = 0n;
  const categories = Object.fromEntries(CATEGORIES.map((name) => [name, { added: 0n, deleted: 0n, complete: true }]));
  const summaries = new Map();
  const projectNames = new Map(data.projects.map((item) => [item.id, item.name]));
  for (const row of records) {
    const share = row.contributors.filter((part) => people.has(part.person_id)).reduce((sum, part) => sum + BigInt(part.share_bp), 0n);
    if (share === 0n) continue;
    keys.add(row.mr_key);
    if (row.status === 'repeat') {
      repeats.add(row.mr_key);
      continue;
    }
    if (row.status !== 'new') {
      pending.add(row.mr_key);
      missingNeural.add(row.mr_key);
      missingSelected.add(row.mr_key);
      for (const value of Object.values(categories)) value.complete = false;
      continue;
    }
    newKeys.add(row.mr_key);
    if (row.sp_neural_ticks === null) missingNeural.add(row.mr_key);
    else neural += BigInt(row.sp_neural_ticks) * share / 10000n;
    if (row.sp_selected_ticks === null) missingSelected.add(row.mr_key);
    else selected += BigInt(row.sp_selected_ticks) * share / 10000n;
    if (['manual_correction', 'manual_stale'].includes(row.selected_source)) manual.add(row.mr_key);
    for (const name of CATEGORIES) {
      const item = row.categories[name];
      const value = categories[name];
      value.added += BigInt(item.known_added) * share * 10000n;
      value.deleted += BigInt(item.known_deleted) * share * 10000n;
      value.complete &&= item.complete && !(name === 'code' && row.categories.unsupported.unknown_files > 0);
    }
    if (row.summary) {
      if (!summaries.has(row.work_unit_id)) summaries.set(row.work_unit_id, { work_unit_id: row.work_unit_id, summary: '', parts: [], mr_keys: [], days: [], projects: [] });
      const item = summaries.get(row.work_unit_id);
      if (!item.parts.includes(row.summary)) item.parts.push(row.summary);
      item.summary = item.parts.join('\n');
      item.mr_keys.push(row.mr_key);
      if (!item.days.includes(row.accepted_day)) item.days.push(row.accepted_day);
      const name = projectNames.get(row.project_id);
      if (!item.projects.includes(name)) item.projects.push(name);
    }
  }
  const lineCategories = {};
  for (const [name, value] of Object.entries(categories)) {
    const complete = completeCoverage && value.complete;
    lineCategories[name] = {
      complete, known_added_ticks: value.added.toString(), known_deleted_ticks: value.deleted.toString(),
      known_churn_ticks: (value.added + value.deleted).toString(), known_net_ticks: (value.added - value.deleted).toString(),
      added_ticks: complete ? value.added.toString() : null, deleted_ticks: complete ? value.deleted.toString() : null,
      churn_ticks: complete ? (value.added + value.deleted).toString() : null, net_ticks: complete ? (value.added - value.deleted).toString() : null,
    };
  }
  return {
    covered: completeCoverage, coverage_statuses: coverage, merged_mr_known: keys.size,
    merged_mr: completeCoverage && records.every((row) => row.source_available) ? keys.size : null,
    new_mr_known: newKeys.size, new_mr: completeCoverage && pending.size === 0 ? newKeys.size : null,
    repeat_mr: repeats.size, pending_mr: pending.size, missing_neural_sp_mr: missingNeural.size,
    missing_selected_sp_mr: missingSelected.size, manual_mr: manual.size,
    sp_neural_known_ticks: neural.toString(), sp_neural_ticks: completeCoverage && missingNeural.size === 0 ? neural.toString() : null,
    sp_selected_known_ticks: selected.toString(), sp_selected_ticks: completeCoverage && missingSelected.size === 0 ? selected.toString() : null,
    code_churn_known_ticks: lineCategories.code.known_churn_ticks, code_churn_ticks: lineCategories.code.churn_ticks,
    line_categories: lineCategories, summaries: [...summaries.values()],
  };
}

export function aggregate(data, filters) {
  const range = dates(filters.from, filters.to);
  const today = filters.today ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const people = new Set(filters.person_ids ?? data.people.map((item) => item.person_id));
  const projects = new Set(filters.project_ids ?? data.projects.map((item) => item.id));
  if ([...people].some((id) => !data.people.some((item) => item.person_id === id)) || [...projects].some((id) => !data.projects.some((item) => item.id === id))) throw new Error('Фильтр содержит неизвестного участника или репозиторий');
  const records = data.records.filter((row) => filters.from <= row.accepted_day && row.accepted_day <= filters.to && projects.has(row.project_id) && row.contributors.some((part) => people.has(part.person_id)));
  const daily = [], rows = [];
  for (const day of range) {
    const selected = records.filter((row) => row.accepted_day === day);
    daily.push({ day, ...summarize(data, selected, people, projects, [day], today) });
    for (const person of [...people].sort()) {
      const own = selected.filter((row) => row.contributors.some((part) => part.person_id === person));
      rows.push({ day, person_id: person, ...summarize(data, own, new Set([person]), projects, [day], today) });
    }
  }
  return { rows, daily, totals: summarize(data, records, people, projects, range, today) };
}

export function exportCsv(result, people, mode = 'neural') {
  const names = new Map(people.map((item) => [item.person_id, item.name]));
  const escape = (value) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[\s]*[=+@-]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const columns = ['Тип строки', 'Дата', 'Участник', 'MR', 'SP', 'Строки кода', 'MR без SP', 'Покрытие'];
  const line = (row, type, name) => [type, row.day ?? '', name, row.merged_mr, row[`sp_${mode === 'neural' ? 'neural' : 'selected'}_ticks`] === null ? null : formatTicks(row[`sp_${mode === 'neural' ? 'neural' : 'selected'}_ticks`], '.'), row.code_churn_ticks === null ? null : formatTicks(row.code_churn_ticks, '.'), row[mode === 'neural' ? 'missing_neural_sp_mr' : 'missing_selected_sp_mr'], coverageLabel(row.coverage_statuses)];
  const lines = result.rows.map((row) => line(row, 'Участник', names.get(row.person_id) ?? row.person_id));
  lines.push(...result.daily.map((row) => line(row, 'Дневной итог', 'Итог выбранных участников')), line(result.totals, 'Итог периода', 'Итог выбранного периода'));
  return '\uFEFF' + [columns, ...lines].map((row) => row.map(escape).join(',')).join('\r\n') + '\r\n';
}
