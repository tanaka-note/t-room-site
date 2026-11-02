/* Move existing service status nodes into the active login card, preserving IDs,
   listeners and the original application placement. No authentication state is changed. */
(() => {
  'use strict';
  function initialize() {
    const origins = new Map();
    for (const view of document.querySelectorAll('.tlain-login-view[data-login-status]')) {
      const node = document.getElementById(view.dataset.loginStatus);
      if (!node || origins.has(node)) continue;
      const anchor = document.createComment('login status origin');
      node.before(anchor); origins.set(node, anchor);
    }
    function update() {
      const views = [...document.querySelectorAll('.tlain-login-view[data-login-status]')];
      for (const [node, anchor] of origins) {
        const view = views.find(view => view.dataset.loginStatus === node.id
          && !view.closest('[hidden]') && !view.querySelector('.tlain-login-card')?.hidden);
        const card = view?.querySelector('.tlain-login-card');
        if (card && !card.contains(node)) card.append(node);
        else if (!card && node.previousSibling !== anchor) anchor.after(node);
      }
    }
    update();
    new MutationObserver(update).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
