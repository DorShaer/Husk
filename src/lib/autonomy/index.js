'use strict';

// Barrel export for Husk Autonomy Mode. main.js requires this once
// and dispatches to the right submodule from each IPC handler.

module.exports = {
  snapshot:   require('./snapshot'),
  audit:      require('./audit'),
  budget:     require('./budget'),
  supervisor: require('./supervisor'),
};
