import { domText } from './textSelection';

// A selection reaching across dates copies as the logbook reads: a heading for
// each date, then the events and entries the selection covers, nested as they
// are on the page. Within one date the outline copies its own entries.
export function copySpannedDays(clipboard: DataTransfer): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  const days = [...document.querySelectorAll<HTMLElement>('[data-day]')]
    .filter(day => day.offsetParent !== null && range.intersectsNode(day));
  if (days.length < 2) return false;

  const lines: string[] = [];
  const document_ = document.createElement('div');
  for (const day of days) {
    const date = day.querySelector('time')?.textContent?.trim();
    if (date) {
      lines.push(`## ${date}`);
      const heading = document.createElement('h2');
      heading.textContent = date;
      document_.append(heading);
    }
    const list = document.createElement('ul');
    const add = (text: string, depth: number, html?: Element) => {
      if (!text) return;
      lines.push('  '.repeat(depth) + '- ' + text.replace(/\n/g, '\n' + '  '.repeat(depth + 1)));
      const item = document.createElement('li');
      if (html) item.innerHTML = html.innerHTML; else item.textContent = text;
      list.append(item);
    };
    for (const event of day.querySelectorAll<HTMLElement>('[data-calendar-event]')) {
      if (range.intersectsNode(event)) add(domText(event).trim(), 0);
    }
    for (const row of day.querySelectorAll<HTMLElement>('li[data-item-id]')) {
      const content = row.querySelector<HTMLElement>(':scope > div > [role="group"], :scope > div [contenteditable="true"]');
      if (!content || content.closest('li') !== row || !range.intersectsNode(content)) continue;
      add(domText(content).trim(), Number(row.dataset.depth ?? 0), content);
    }
    if (list.children.length) document_.append(list);
  }
  if (!lines.length) return false;
  clipboard.setData('text/plain', lines.join('\n'));
  clipboard.setData('text/html', document_.innerHTML);
  return true;
}
