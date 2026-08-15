/* =====================================================================
   Currency formatting — one place, used by both the customer app and
   the staff board.

   If Arquero's ever opens somewhere else, or the peso symbol needs to
   render differently, this is the only file to change.
   ===================================================================== */

(function (global) {
  'use strict';

  const formatter = new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  /** 450 -> "₱450.00", 1000 -> "₱1,000.00" */
  global.money = function money(amount) {
    const n = Number(amount);
    return formatter.format(Number.isFinite(n) ? n : 0);
  };
})(window);
