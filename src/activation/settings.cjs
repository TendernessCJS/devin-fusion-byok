'use strict';
function globalSetting(settings, key) {
  return typeof settings.inspect === 'function' ? settings.inspect(key)?.globalValue || {} : settings.get(key, {});
}

module.exports = { globalSetting };
