import { aggregate, selectDashboard, formatTicks, exportCsv, coverageLabel } from './aggregate.mjs';

const $ = (id) => document.getElementById(id);
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const date = (day) => new Date(`${day}T00:00:00Z`);
const formatDate = (day, options) => new Intl.DateTimeFormat('ru-RU', { ...options, timeZone: 'UTC' }).format(date(day));
const fullDate = (day) => formatDate(day, { day: 'numeric', month: 'long', year: 'numeric' }).replace(' г.', '');
const shortDate = (day) => formatDate(day, { day: 'numeric', month: 'short' }).replace('.', '');
const tableDate = (day) => day.split('-').reverse().join('.');
const shiftDay = (day, amount) => { const value = date(day); value.setUTCDate(value.getUTCDate() + amount); return value.toISOString().slice(0, 10); };
const teams = { frontend: 'Frontend-разработка', backend: 'Backend-разработка', other: 'Другие участники' };
const teamBadge = { frontend: 'Frontend', backend: 'Backend', other: 'Команда' };
const statuses = { new: 'Новый результат', repeat: 'Повторный перенос', repeat_pending: 'Перенос требует проверки', mixed_pending: 'Результат требует проверки', source_unavailable: 'Источник недоступен' };
let data, result, selection = 'all', metric = 'tasks', range, opener;
const mode = () => $('mode').value === 'selected' ? 'selected' : 'neural';
const filters = () => ({ ...range, selection, ...($('project').value ? { project_ids: [$('project').value] } : {}) });
const metricConfig = () => ({
  tasks: { field: 'merged_mr', known: 'merged_mr_known', label: 'принятых MR за период', column: 'Результат', ticks: false },
  lines: { field: 'code_churn_ticks', known: 'code_churn_known_ticks', label: 'строк кода изменено', column: 'Строки кода', ticks: true },
  points: { field: `sp_${mode()}_ticks`, known: `sp_${mode()}_known_ticks`, label: 'очков сложности (SP)', column: 'Очки сложности (SP)', ticks: true },
})[metric];
function display(node, total, known, ticks = true, prefix = '', suffix = '') {
  const format = (value) => ticks ? formatTicks(value) : String(value);
  node.textContent = total === null ? '—' : `${prefix}${format(total)}${suffix}`;
  if (total === null && known !== null) node.append(element('small', `${prefix}${format(known)}${suffix} · известная часть`));
}
function selectionTitle() {
  if (selection === 'all') return 'Вся команда';
  if (selection.startsWith('group:')) return teams[selection.slice(6)];
  return data.people.find((person) => selection === `person:${person.person_id}`)?.name ?? 'Исполнитель';
}
function seriesClass(person) {
  return `series-${data.people.findIndex((row) => row.person_id === person.person_id) % 5 + 1}`;
}
function renderSidebar() {
  const nodes = [];
  const add = (key, name, className = '') => {
    const totals = selectDashboard(data, { ...filters(), selection: key }).totals;
    let button = [...$('performer-nav').children].find((node) => node.dataset.selection === key);
    if (!button) {
      button = element('button', undefined, `nav-item ${className}`);
      button.type = 'button';
      button.dataset.selection = key;
      button.append(element('span', name), element('span', '', 'badge-count'));
      button.addEventListener('click', () => { selection = key; render(); });
    }
    button.classList.toggle('active', key === selection);
    button.setAttribute('aria-pressed', String(key === selection));
    button.lastElementChild.textContent = `${totals.merged_mr === null ? '≥ ' : ''}${totals.merged_mr_known}`;
    button.lastElementChild.title = totals.merged_mr === null ? 'Известное число MR; полный итог не подтверждён' : 'Принятые MR за период';
    nodes.push(button);
  };
  add('all', 'Все программисты');
  for (const [team, name] of Object.entries(teams)) {
    const people = data.people.filter((person) => (person.team ?? 'other') === team);
    if (!people.length) continue;
    add(`group:${team}`, name, 'group-item');
    for (const person of people) add(`person:${person.person_id}`, person.name, 'sub-item');
  }
  if (!nodes.every((node, index) => $('performer-nav').children[index] === node)) $('performer-nav').replaceChildren(...nodes);
}
function svgElement(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderChart() {
  const config = metricConfig(), multi = result.people.length > 1;
  const width = Math.max(290, $('chart').clientWidth || 650), height = 200, left = 44, right = 24, top = 24, bottom = 35;
  const chartWidth = width - left - right, chartHeight = height - top - bottom;
  const rowsByPerson = new Map(result.people.map((person) => [person.person_id, result.rows.filter((row) => row.person_id === person.person_id)]));
  const series = result.people.map((person) => ({ person, values: rowsByPerson.get(person.person_id).map((row) => {
    const missing = metric === 'points' && row[`missing_${mode()}_sp_mr`] > 0 && row[`missing_${mode()}_sp_mr`] === row.merged_mr_known && row[config.known] === '0';
    const raw = row[config.field] ?? (row.merged_mr_known > 0 && !missing ? row[config.known] : null);
    return { day: row.day, raw, partial: row[config.field] === null, numeric: raw === null ? null : Number(config.ticks ? formatTicks(raw, '.') : raw) };
  }) }));
  const maximum = Math.max(1, ...series.flatMap((row) => row.values.map((value) => value.numeric ?? 0)));
  const step = Math.ceil((maximum / 2) / (10 ** Math.floor(Math.log10(maximum / 2))));
  const scale = step * (10 ** Math.floor(Math.log10(maximum / 2))) * 2;
  const x = (index) => left + chartWidth * (result.daily.length === 1 ? .5 : index / (result.daily.length - 1));
  const y = (number) => top + chartHeight * (1 - number / scale);
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${selectionTitle()}. ${config.label}. ${fullDate(range.from)} — ${fullDate(range.to)}. Точные значения доступны в подсказках точек и CSV.` });
  svg.append(svgElement('title', {}, `${selectionTitle()} · ${config.label}`));
  for (const part of [0, .5, 1]) {
    svg.append(svgElement('line', { x1: left, y1: y(scale * part), x2: width - right, y2: y(scale * part), class: 'grid-line' }));
    svg.append(svgElement('text', { x: left - 8, y: y(scale * part) + 4, 'text-anchor': 'end' }, new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(scale * part)));
  }
  const maxLabels = Math.max(2, Math.floor(chartWidth / 80));
  const labelCount = Math.min(maxLabels, result.daily.length);
  const indices = new Set(Array.from({ length: labelCount }, (_, i) => Math.round(i * (result.daily.length - 1) / Math.max(1, labelCount - 1))));
  for (const i of indices) {
    svg.append(svgElement('line', { x1: x(i), y1: top, x2: x(i), y2: height - bottom, class: 'vertical-line' }));
    svg.append(svgElement('text', { x: x(i), y: height - 10, 'text-anchor': 'middle' }, shortDate(result.daily[i].day)));
  }
  for (const { person, values } of series) {
    const group = svgElement('g', { class: multi ? seriesClass(person) : 'series-single', 'data-person': person.person_id });
    let path = '', active = false;
    for (const [index, value] of values.entries()) {
      if (value.raw === null || value.partial) { active = false; continue; }
      path += `${active ? 'L' : 'M'}${x(index)},${y(value.numeric)} `;
      active = true;
    }
    if (!multi && values.every((value) => value.raw !== null && !value.partial)) {
      const points = values.map((value, index) => `${x(index)},${y(value.numeric)}`).join(' ');
      group.append(svgElement('polygon', { points: `${x(0)},${height - bottom} ${points} ${x(values.length - 1)},${height - bottom}`, fill: 'var(--accent-soft)' }));
    }
    group.append(svgElement('path', { d: path, class: 'chart-line' }));
    for (const [index, value] of values.entries()) {
      if (value.raw === null) continue;
      const text = `${person.name}, ${fullDate(value.day)}: ${config.ticks ? formatTicks(value.raw) : value.raw}${value.partial ? ' · известная часть' : ''}`;
      const point = svgElement('circle', { cx: x(index), cy: y(value.numeric), r: values.length > 90 ? 2 : 4.5, class: `chart-point${value.partial ? ' partial' : ''}`, 'aria-label': text });
      point.append(svgElement('title', {}, text));
      group.append(point);
      if (!multi && values.length <= 10 && value.numeric > 0) group.append(svgElement('text', { x: x(index), y: y(value.numeric) - 10, 'text-anchor': 'middle' }, config.ticks ? formatTicks(value.raw) : value.raw));
    }
    svg.append(group);
  }
  $('chart').replaceChildren(svg);
  $('chart-legend').replaceChildren(...result.people.map((person) => {
    const chip = element('span', undefined, `legend-chip ${multi ? seriesClass(person) : 'series-single'}`);
    chip.append(element('span', undefined, 'legend-dot'), element('span', person.name));
    return chip;
  }));
  $('chart-legend').hidden = !multi;
  const partial = series.some((row) => row.values.some((value) => value.partial));
  $('chart-note').textContent = partial ? 'Полые пунктирные точки — известная часть. Разрывы — нет полного подтверждённого значения.' : metric === 'tasks' && multi ? 'Совместный MR показан у каждого исполнителя; общий итог учитывает его один раз.' : 'Дата на графике — день принятия результата в проект.';
}
function recordStats(row) {
  const ids = new Set(result.people.map((person) => person.person_id));
  const share = BigInt(row.contributors.filter((part) => ids.has(part.person_id)).reduce((sum, part) => sum + part.share_bp, 0));
  const repeated = row.status === 'repeat', accepted = row.status === 'new';
  if (!accepted && !repeated) return { points: null, added: null, deleted: null, known: null, complete: false, lines: null, share };
  const sp = row[`sp_${mode()}_ticks`];
  const points = repeated ? '0' : accepted && sp !== null ? (BigInt(sp) * share / 10000n).toString() : null;
  const code = row.categories.code;
  const complete = accepted && code.complete && row.categories.unsupported.unknown_files === 0;
  const added = repeated ? '0' : (BigInt(code.known_added) * share * 10000n).toString();
  const deleted = repeated ? '0' : (BigInt(code.known_deleted) * share * 10000n).toString();
  const known = (BigInt(added) + BigInt(deleted)).toString();
  return { points, added, deleted, known, complete: complete || repeated, lines: complete || repeated ? known : null, share };
}
function recordTitle(row) {
  const title = (row.details?.title ?? row.summary?.split('\n')[0] ?? 'Принятый результат без публичного описания').replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '');
  return title.charAt(0).toLocaleUpperCase('ru-RU') + title.slice(1);
}
function renderTable() {
  const config = metricConfig(), nodes = [];
  $('metric-column').textContent = config.column;
  for (const row of result.records) {
    const stats = recordStats(row), tr = element('tr', undefined, 'table-row'), idCell = element('td');
    const button = element('button', row.details ? `!${row.details.iid}` : 'Открыть', 'mr-button');
    button.type = 'button';
    button.setAttribute('aria-label', `Открыть работу: ${recordTitle(row)}`);
    button.addEventListener('click', () => openModal(row, button));
    idCell.append(button);
    tr.addEventListener('click', (event) => { if (!event.target.closest('button')) { button.focus(); openModal(row, button); } });
    const title = element('td');
    title.append(element('span', row.details?.module ?? data.projects.find((project) => project.id === row.project_id).name, 'task-module'), element('span', recordTitle(row), 'task-desc'));
    const people = element('td');
    for (const part of row.contributors) {
      const person = data.people.find((person) => person.person_id === part.person_id);
      const line = element('div');
      line.append(element('span', person?.name ?? 'Участник', 'person-name'));
      if (person?.team && person.team !== 'other') line.append(element('span', teamBadge[person.team], 'team-badge'));
      people.append(line);
    }
    const metricCell = element('td', undefined, 'metric-cell');
    const pill = element('span', undefined, 'metric-pill');
    if (metric === 'tasks') pill.textContent = '1 MR';
    else if (metric === 'points') display(pill, stats.points, '0', true, '★ ', ' SP');
    else display(pill, stats.lines, stats.known, true);
    if (metric === 'points' && stats.points === null) pill.textContent = '— SP';
    metricCell.append(pill);
    if (metric === 'lines' && stats.known !== null) metricCell.append(element('small', `${stats.complete ? '' : 'Известно: '}+${formatTicks(stats.added)} / −${formatTicks(stats.deleted)}`));
    if (row.status !== 'new') metricCell.append(element('small', statuses[row.status]));
    const project = data.projects.find((project) => project.id === row.project_id);
    idCell.append(element('small', project.name, 'repo-label'));
    tr.append(idCell, title, people, metricCell, element('td', tableDate(row.accepted_day), 'date-cell'), element('td', '›', 'row-chevron'));
    nodes.push(tr);
  }
  if (!nodes.length) {
    const tr = element('tr'), td = element('td', result.totals.covered ? 'За выбранный период нет принятых работ' : 'За выбранный период нет подтверждённых работ. Данные ещё не собраны.', 'empty');
    td.colSpan = 6;
    tr.append(td);
    nodes.push(tr);
  }
  $('tasks-table').replaceChildren(...nodes);
  $('table-heading').textContent = selection === 'all' ? 'Выполненные работы всей команды' : `Выполненные работы: ${selectionTitle()}`;
  $('table-counter').textContent = `${result.totals.merged_mr === null ? '≥ ' : ''}${result.records.length} MR`;
  $('table-note').textContent = `${result.totals.new_mr_known} MR с новым результатом${result.totals.repeat_mr ? ` · ${result.totals.repeat_mr} повторных переносов` : ''}${result.totals.pending_mr ? ` · ${result.totals.pending_mr} требуют проверки` : ''}. Сначала последние работы. Выберите строку, чтобы открыть подробности.`;
}
function render() {
  result = selectDashboard(data, filters());
  renderSidebar();
  const config = metricConfig(), totals = result.totals;
  display($('metric-value'), totals[config.field], totals[config.known], config.ticks);
  $('metric-label').textContent = config.label;
  $('chart-subtitle').textContent = `${selectionTitle()} · динамика по дням`;
  document.querySelectorAll('[data-metric]').forEach((button) => {
    button.classList.toggle('active', button.dataset.metric === metric);
    button.setAttribute('aria-pressed', String(button.dataset.metric === metric));
  });
  $('selected-date').textContent = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).formatRange(date(range.from), date(range.to)).replaceAll(' г.', '');
  document.querySelectorAll('[data-from]').forEach((button) => button.classList.toggle('active', button.dataset.from === range.from && button.dataset.to === range.to));
  renderChart();
  renderTable();
  const missing = totals[`missing_${mode()}_sp_mr`];
  $('coverage').classList.toggle('partial', !totals.covered || missing > 0 || totals.code_churn_ticks === null || totals.pending_mr > 0);
  $('coverage').textContent = `${coverageLabel(totals.coverage_statuses)}.${missing ? ` ${missing} MR без актуальной оценки SP.` : ''}${totals.code_churn_ticks === null ? ' Строки кода известны частично.' : ''}${totals.pending_mr ? ` ${totals.pending_mr} MR требуют проверки.` : ''}`;
  $('categories').replaceChildren(...Object.entries({ code: 'Код', tests: 'Тесты', documentation: 'Документация', configuration: 'Конфигурация' }).map(([key, name]) => {
    const row = totals.line_categories[key], block = element('div');
    block.append(element('strong', name), element('p', `${row.complete ? '' : 'Известно: '}+${formatTicks(row.known_added_ticks)} / −${formatTicks(row.known_deleted_ticks)}`));
    return block;
  }));
}
function openModal(row, button) {
  const stats = recordStats(row), details = row.details;
  opener = button;
  $('modal-title').textContent = recordTitle(row);
  $('modal-person').textContent = row.contributors.map((part) => {
    const person = data.people.find((person) => person.person_id === part.person_id);
    return `${person?.name ?? 'Участник'}${person?.team && person.team !== 'other' ? ` (${teamBadge[person.team]})` : ''}${row.contributors.length > 1 ? ` · ${part.share_bp / 100}%` : ''}`;
  }).join(', ');
  $('modal-date').textContent = tableDate(row.accepted_day);
  $('modal-module').textContent = details?.module ?? data.projects.find((project) => project.id === row.project_id).name;
  $('modal-points').textContent = stats.points === null ? 'Оценка пока неизвестна' : `${formatTicks(stats.points)} SP`;
  $('modal-description').textContent = row.summary ?? 'Публичное описание этой работы пока не подготовлено.';
  display($('modal-added'), stats.complete ? stats.added : null, stats.added, true, '+');
  display($('modal-deleted'), stats.complete ? stats.deleted : null, stats.deleted, true, '−');
  if (details) display($('modal-files'), details.files_changed, details.files_known, false);
  else $('modal-files').textContent = '—';
  $('modal-note').textContent = `${statuses[row.status]}. ${stats.share < 10000n ? 'SP и строки показаны для выбранных исполнителей. ' : ''}Число файлов относится ко всему MR.${row.status === 'repeat' ? ' Повторный перенос не добавляет SP и строки к результату.' : ''}`;
  const safeLink = details?.web_url && /^https:\/\/gitlab\.com\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+\/-\/merge_requests\/[1-9][0-9]*$/.test(details.web_url);
  $('modal-link').hidden = !safeLink;
  if (safeLink) $('modal-link').href = details.web_url;
  else $('modal-link').removeAttribute('href');
  $('task-modal').showModal();
  $('modal-close').focus();
}
function closeModal() { $('task-modal').close(); }
function setDropdown(open, focus = false) {
  $('date-dropdown').hidden = !open;
  $('date-picker').setAttribute('aria-expanded', String(open));
  if (focus) (open ? $('date-presets').firstElementChild : $('date-picker')).focus();
}
function applyRange(from, to) {
  try {
    aggregate(data, { from, to });
  } catch (error) {
    $('filter-error').textContent = error.message;
    $('filter-error').hidden = false;
    return false;
  }
  range = { from, to };
  $('from').value = from;
  $('to').value = to;
  $('filter-error').hidden = true;
  render();
  setDropdown(false, true);
  return true;
}
function reset() {
  range = { ...data.period };
  selection = 'all';
  metric = 'tasks';
  $('from').value = range.from;
  $('to').value = range.to;
  $('project').value = '';
  $('mode').value = 'neural';
  $('filter-error').hidden = true;
  render();
}
function presets() {
  const end = data.period.to, month = end.slice(0, 7) + '-01';
  const ranges = [
    ['Последние 7 дней данных', shiftDay(end, -6), end],
    ['Предыдущие 7 дней', shiftDay(end, -13), shiftDay(end, -7)],
    ['Последний месяц данных', month, end],
    ['Весь период', data.period.from, end],
  ];
  $('date-presets').replaceChildren(...ranges.map(([name, from, to]) => {
    const button = element('button', name, 'date-opt');
    button.type = 'button';
    button.dataset.from = from;
    button.dataset.to = to;
    button.addEventListener('click', () => applyRange(from, to));
    return button;
  }));
}
async function load() {
  $('load-state').hidden = false;
  $('retry').hidden = true;
  $('dashboard').hidden = true;
  $('date-picker').disabled = true;
  $('load-state').textContent = 'Загружаем сохранённую статистику…';
  setDropdown(false);
  try {
    const response = await fetch('./data/metrics.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Данные недоступны');
    data = await response.json();
    if (data.schema_version !== '1.0' || data.tick_denominator !== '100000000' || !Array.isArray(data.records) || !Array.isArray(data.people) || !Array.isArray(data.projects)) throw new Error('Неверный формат данных');
    $('project').replaceChildren(new Option('Все репозитории', ''), ...data.projects.map((project) => new Option(project.name, project.id)));
    $('performer-nav').replaceChildren();
    presets();
    $('dashboard').hidden = false;
    reset();
    const stamp = (value) => value ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(value)) : 'дата не указана';
    $('updated').textContent = `Данные: ${stamp(data.source_updated_at)} МСК · Сборка: ${stamp(data.retrieved_at)} МСК`;
    $('load-state').hidden = true;
    $('date-picker').disabled = false;
  } catch {
    $('dashboard').hidden = true;
    $('load-state').textContent = 'Не удалось загрузить статистику. Проверьте подключение и повторите загрузку.';
    $('retry').hidden = false;
    $('updated').textContent = 'Данные недоступны';
    $('selected-date').textContent = 'Период недоступен';
  }
}
$('filters').addEventListener('submit', (event) => { event.preventDefault(); applyRange($('from').value, $('to').value); });
$('date-picker').addEventListener('click', () => setDropdown($('date-dropdown').hidden, true));
$('date-picker').addEventListener('keydown', (event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setDropdown(true, true); } });
for (const id of ['project', 'mode']) $(id).addEventListener('change', render);
for (const button of document.querySelectorAll('[data-metric]')) button.addEventListener('click', () => { metric = button.dataset.metric; render(); });
$('reset').addEventListener('click', reset);
$('retry').addEventListener('click', load);
$('modal-close').addEventListener('click', closeModal);
$('modal-dismiss').addEventListener('click', closeModal);
$('task-modal').addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });
$('task-modal').addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const buttons = [...$('task-modal').querySelectorAll('button, a[href]')].filter((node) => !node.hidden && !node.disabled);
  const first = buttons[0], last = buttons.at(-1);
  if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
});
$('task-modal').addEventListener('click', (event) => {
  if (event.target !== $('task-modal')) return;
  const rect = $('task-modal').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeModal();
});
document.addEventListener('click', (event) => { if (!event.target.closest('.date-picker-wrapper') && !$('date-dropdown').hidden) setDropdown(false); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('date-dropdown').hidden) { event.preventDefault(); setDropdown(false, true); } });
document.addEventListener('focusin', (event) => { if (!event.target.closest('.date-picker-wrapper') && !$('date-dropdown').hidden) setDropdown(false); });
$('csv').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([exportCsv(result, data.people, mode())], { type: 'text/csv;charset=utf-8' }));
  const link = element('a');
  link.href = url;
  link.download = `statistics-${range.from}-${range.to}-${mode()}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
new ResizeObserver(() => { if (result && !$('dashboard').hidden) renderChart(); }).observe($('chart'));
load();
