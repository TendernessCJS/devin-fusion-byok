'use strict';
const ORDER_MAX = 0xffff;
// An absent order ranks after every ordered sibling, so a legacy config with
// no order fields behaves exactly like "order of insertion": old entries keep
// their array positions until the user moves something.
function orderOf(item) {
  const order = item?.order;
  return Number.isSafeInteger(order) && order >= 0 && order <= ORDER_MAX ? order : Infinity;
}
function sortByOrder(list) {
  return (Array.isArray(list) ? list : []).map((item, index) => ({ item, index }))
    .sort((a, b) => (orderOf(a.item) - orderOf(b.item)) || (a.index - b.index))
    .map(entry => entry.item);
}
function nextOrder(list) {
  let max = -1;
  (Array.isArray(list) ? list : []).forEach((item, index) => {
    const order = orderOf(item);
    const position = order === Infinity ? index : order;
    if (position > max) max = position;
  });
  return max + 1;
}
// Numbers the list in its current DISPLAY sequence, not its array sequence:
// a hand-edited config may hold an array order that disagrees with the
// persisted orders, and numbering by array position would silently promote
// that stale array order into the canonical one.
function normalizeOrders(list) {
  sortByOrder(list).forEach((item, index) => { item.order = index; });
}
module.exports = { ORDER_MAX, orderOf, sortByOrder, nextOrder, normalizeOrders };
