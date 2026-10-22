// Either a narrow width or a short height needs the three-pane pager.
// The sidebar rail needs a gutter of its own beside the page. Below this
// there is no room for one, and the tags take a tab instead.
export const narrowViewport = '(max-width: 800px)';
export const shortViewport = '(max-height: 480px)';
export const compactViewport = `${narrowViewport}, ${shortViewport}`;
export const fullViewport = '(min-width: 801px) and (min-height: 481px)';
