/* =====================================================================
   Shared escaping helpers — loaded by both the customer app and the
   staff dashboard.

   There is exactly one implementation of this in the project on purpose.
   Escaping is the thing that stops text from a customer or the database
   being treated as code, so it should be one piece of code that is easy
   to find, read and trust — not copied into every file that renders
   something.
   ===================================================================== */

(function (global) {
  'use strict';

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, ch => ESCAPES[ch]);
  }

  /** Marks a string as already-safe markup so html`` won't escape it again. */
  class SafeHtml {
    constructor(value) { this.value = value; }
    toString() { return this.value; }
  }

  const raw = value => new SafeHtml(value);

  /**
   * Tagged template that escapes every interpolation.
   *   html`<h4>${item.name}</h4>`    -> name is escaped
   *   html`<div>${raw(rows)}</div>`  -> rows is inserted as markup
   *   html`<ul>${arrayOfSafeHtml}</ul>` -> array members joined
   */
  function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v instanceof SafeHtml) out += v.value;
      else if (Array.isArray(v)) out += v.map(x => (x instanceof SafeHtml ? x.value : esc(x))).join('');
      else out += esc(v);
      out += strings[i + 1];
    }
    return out;
  }

  global.esc = esc;
  global.raw = raw;
  global.html = html;
})(window);
