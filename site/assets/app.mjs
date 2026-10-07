import { aggregate, formatTicks, exportCsv, coverageLabel } from './aggregate.mjs';

const $ = (id) => document.getElementById(id);
let data, result;
const shortDate = (day) => new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
const fullDate = (day) => new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
const mode = () => $('mode').value === 'neural' ? 'neural' : 'selected';
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function value(node, total, known, ticks = true) {
  node.replaceChildren(document.createTextNode(ticks ? formatTicks(total) : total === null ? '—' : String(total)));
  if (total === null) node.append(element('small', `${ticks ? formatTicks(known) : known} · известная часть`));
}
function cell(total, known, ticks = true) {
  const node = element('td');
  value(node, total, known, ticks);
  return node;
}
function svgElement(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, val] of Object.entries(attributes)) node.setAttribute(key, val);
  if (text !== undefined) node.textContent = text;
  return node;
}
function chart(id, label, field, knownField, ticks, bars = false) {
  const values = result.daily.map((row) => {
    const total = row[field], known = row[knownField];
    const missing = field.startsWith('sp_') && total === null && row[`missing_${mode()}_sp_mr`] === row.merged_mr_known && known === '0';
    const hasKnown = row.merged_mr_known > 0 && !missing;
    return { day: row.day, partial: total === null, raw: total ?? (hasKnown ? known : null) };
  });
  const numeric = (raw) => raw === null ? null : Number(ticks ? formatTicks(raw, '.') : raw);
  const maximum = Math.max(1, ...values.map((row) => numeric(row.raw) ?? 0));
  const width = 360, height = 175, left = 38, right = 14, top = 15, bottom = 33;
  const x = (i) => left + (width - left - right) * (values.length === 1 ? 0.5 : i / (values.length - 1));
  const y = (raw) => height - bottom - (height - top - bottom) * numeric(raw) / maximum;
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${label}. Значения по дням приведены в таблице ниже.` });
  svg.append(svgElement('title', {}, `${label}: ${fullDate($('from').value)} — ${fullDate($('to').value)}`));
  for (const part of [0, 0.5, 1]) {
    const py = height - bottom - (height - top - bottom) * part;
    svg.append(svgElement('line', { x1: left, y1: py, x2: width - right, y2: py, class: 'grid-line' }));
    svg.append(svgElement('text', { x: left - 7, y: py + 4, 'text-anchor': 'end' }, new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(maximum * part)));
  }
  let path = '', active = false;
  for (const [i, row] of values.entries()) {
    if (row.raw === null) { active = false; continue; }
    if (row.partial) { active = false; continue; }
    path += `${active ? 'L' : 'M'}${x(i)},${y(row.raw)} `;
    active = true;
  }
  if (!bars) svg.append(svgElement('path', { d: path, class: 'chart-line' }));
  for (const [i, row] of values.entries()) {
    if (row.raw === null) {
      const marker = svgElement('text', { x: x(i), y: height - bottom + 6, 'text-anchor': 'middle', class: 'chart-unknown' }, '·');
      marker.append(svgElement('title', {}, `${fullDate(row.day)}: нет подтверждённого значения`));
      svg.append(marker);
      continue;
    }
    const marker = bars && !row.partial && numeric(row.raw) > 0 ? svgElement('rect', { x: x(i) - 3, y: y(row.raw), width: 6, height: height - bottom - y(row.raw), class: 'chart-bar' }) : svgElement('circle', { cx: x(i), cy: y(row.raw), r: row.partial ? 3.5 : 2.5, class: `chart-point${row.partial ? ' partial' : ''}` });
    marker.append(svgElement('title', {}, `${fullDate(row.day)}: ${ticks ? formatTicks(row.raw) : row.raw}${row.partial ? ' (известная часть)' : ''}`));
    svg.append(marker);
  }
  const indices = [...new Set([0, Math.floor((values.length - 1) / 2), values.length - 1])];
  for (const i of indices) svg.append(svgElement('text', { x: x(i), y: height - 8, 'text-anchor': 'middle' }, shortDate(values[i].day)));
  $(id).replaceChildren(svg);
}
function render() {
  try {
    result = aggregate(data, { from: $('from').value, to: $('to').value, ...($('person').value ? { person_ids: [$('person').value] } : {}), ...($('project').value ? { project_ids: [$('project').value] } : {}) });
  } catch (error) {
    $('filter-error').textContent = error.message;
    $('filter-error').hidden = false;
    $('result').hidden = true;
    return;
  }
  $('filter-error').hidden = true;
  $('result').hidden = false;
  const totals = result.totals, sp = `sp_${mode()}`, missing = totals[`missing_${mode()}_sp_mr`];
  const partial = !totals.covered || totals.merged_mr === null || missing > 0 || totals.code_churn_ticks === null;
  $('coverage').className = `coverage${partial ? ' partial' : ''}`;
  $('coverage').textContent = `${totals.covered ? 'Список MR за период подтверждён.' : coverageLabel(totals.coverage_statuses) + '.'} ${missing ? `${missing} MR без актуальной оценки SP.` : totals.covered ? 'Все выбранные MR имеют актуальные оценки SP.' : 'Полный итог SP пока неизвестен.'} ${totals.code_churn_ticks === null ? 'Изменения кода известны частично.' : 'Изменения кода посчитаны полностью.'}${totals.pending_mr ? ` ${totals.pending_mr} MR требуют проверки источника или повторного переноса.` : ''}`;
  value($('mr-value'), totals.merged_mr, totals.merged_mr_known, false);
  value($('sp-value'), totals[`${sp}_ticks`], totals[`${sp}_known_ticks`]);
  value($('loc-value'), totals.code_churn_ticks, totals.code_churn_known_ticks);
  $('mr-note').textContent = `Уникальные слияния · ${totals.new_mr_known} новых · ${totals.repeat_mr} повторных · ${totals.pending_mr} требуют проверки`;
  $('sp-note').textContent = `${mode() === 'neural' ? 'Исходные нейросетевые оценки' : 'Оценки с ручными поправками'} · ${missing} MR без SP${mode() === 'selected' ? ` · ${totals.manual_mr} MR с поправками` : ''}`;
  $('loc-note').textContent = 'Добавленные + удалённые строки кода. Тесты и документы — отдельно, в методике ниже.';
  chart('chart-mr', 'Принятые MR', 'merged_mr', 'merged_mr_known', false, true);
  chart('chart-sp', 'Оценка SP', `${sp}_ticks`, `${sp}_known_ticks`, true);
  chart('chart-loc', 'Изменения кода', 'code_churn_ticks', 'code_churn_known_ticks', true);
  const names = new Map(data.people.map((row) => [row.person_id, row.name]));
  const fragment = document.createDocumentFragment();
  const tableRow = (row, name, className) => {
    const tr = element('tr', undefined, className);
    tr.append(element('td', row.day ? row.day.split('-').reverse().join('.') : 'Весь период'), element('td', name), cell(row.merged_mr, row.merged_mr_known, false), cell(row[`${sp}_ticks`], row[`${sp}_known_ticks`]), cell(row.code_churn_ticks, row.code_churn_known_ticks));
    const states = [];
    if (!row.covered) states.push(coverageLabel(row.coverage_statuses));
    if (row[`missing_${mode()}_sp_mr`]) states.push(`${row[`missing_${mode()}_sp_mr`]} MR без SP`);
    if (row.code_churn_ticks === null) states.push('Строки частично');
    if (row.pending_mr) states.push(`${row.pending_mr} MR требуют проверки`);
    if (row.repeat_mr) states.push(`${row.repeat_mr} повторных MR`);
    tr.append(element('td', states.join(' · ') || 'Подтверждено', 'row-state'));
    return tr;
  };
  const daily = new Map(result.daily.map((row) => [row.day, row]));
  let previousDay;
  for (const row of [...result.rows].sort((a, b) => b.day.localeCompare(a.day) || names.get(a.person_id).localeCompare(names.get(b.person_id), 'ru'))) {
    if (previousDay !== row.day) {
      fragment.append(tableRow(daily.get(row.day), 'Итог выбранных участников', 'daily-total'));
      previousDay = row.day;
    }
    const tr = tableRow(row, names.get(row.person_id), 'person-row');
    fragment.append(tr);
  }
  $('table-body').replaceChildren(fragment);
  $('table-total').replaceChildren(tableRow(totals, 'Итог выбранного периода', 'period-total'));
  $('table-note').textContent = `${fullDate($('from').value)} — ${fullDate($('to').value)} · ${result.rows.length} строк участников и ${result.daily.length} дневных итогов · Сначала последние дни. Ноль — подтверждённое отсутствие работ.`;
  const briefs = document.createDocumentFragment();
  for (const row of [...totals.summaries].sort((a, b) => b.days.at(-1).localeCompare(a.days.at(-1)))) {
    const li = element('li'), meta = element('div', undefined, 'brief-meta');
    meta.append(element('p', row.days.map(shortDate).join(', ')), element('p', row.projects.join(' / ')));
    li.append(meta, element('p', row.summary, 'brief-text'));
    briefs.append(li);
  }
  if (!totals.summaries.length) {
    const li = element('li');
    li.append(element('p', totals.merged_mr_known ? 'Для выбранных работ публичная выжимка пока не подготовлена.' : totals.covered ? 'За выбранный период принятых MR нет.' : 'За выбранный период нет подтверждённых результатов.', 'empty'));
    briefs.append(li);
  }
  $('brief-list').replaceChildren(briefs);
  const categories = document.createDocumentFragment();
  for (const [key, name] of Object.entries({ code: 'Код', tests: 'Тесты', documentation: 'Документация', configuration: 'Конфигурация' })) {
    const row = totals.line_categories[key], block = element('div');
    block.append(element('strong', name), element('p', `${row.complete ? '' : 'Известная часть: '}+${formatTicks(row.known_added_ticks)} / −${formatTicks(row.known_deleted_ticks)}`), element('p', `Изменено: ${formatTicks(row.known_churn_ticks)} · Чистое изменение: ${formatTicks(row.known_net_ticks)}`));
    categories.append(block);
  }
  $('categories').replaceChildren(categories);
}
function reset() {
  $('from').value = data.period.from;
  $('to').value = data.period.to;
  $('person').value = '';
  $('project').value = '';
  $('mode').value = 'neural';
  render();
}
async function load() {
  $('load-state').hidden = false;
  $('retry').hidden = true;
  $('dashboard').hidden = true;
  $('load-state').textContent = 'Загружаем сохранённую статистику…';
  try {
    const response = await fetch('./data/metrics.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Данные недоступны');
    data = await response.json();
    if (data.schema_version !== '1.0' || data.tick_denominator !== '100000000' || !Array.isArray(data.records) || !Array.isArray(data.people) || !Array.isArray(data.projects)) throw new Error('Неверный формат данных');
    for (const [id, rows, key, empty] of [['person', data.people, 'person_id', 'Вся команда'], ['project', data.projects, 'id', 'Все репозитории']]) {
      const options = [new Option(empty, ''), ...rows.map((row) => new Option(row.name, row[key]))];
      $(id).replaceChildren(...options);
    }
    const stamp = (value) => value ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(value)) : 'дата не указана';
    $('updated').textContent = `Данные: ${stamp(data.source_updated_at)} МСК · Сборка: ${stamp(data.retrieved_at)} МСК`;
    reset();
    $('dashboard').hidden = false;
    $('load-state').hidden = true;
  } catch {
    $('load-state').textContent = 'Не удалось загрузить статистику. Проверьте подключение и повторите загрузку.';
    $('retry').hidden = false;
    $('updated').textContent = 'Данные недоступны';
  }
}
$('filters').addEventListener('submit', (event) => event.preventDefault());
for (const id of ['from', 'to', 'person', 'project', 'mode']) $(id).addEventListener('change', render);
$('reset').addEventListener('click', reset);
$('retry').addEventListener('click', load);
$('csv').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([exportCsv(result, data.people, mode())], { type: 'text/csv;charset=utf-8' }));
  const link = element('a');
  link.href = url;
  link.download = `statistics-${$('from').value}-${$('to').value}-${mode()}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
load();
