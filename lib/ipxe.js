'use strict';

// Tiny mustache-ish renderer: {{var}} substitution only, unknown vars render
// empty. iPXE scripts are line-oriented plain text; nothing fancier needed.
function render(template, vars) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) =>
    (vars[key] === undefined || vars[key] === null) ? '' : String(vars[key])
  );
}

module.exports = { render };
