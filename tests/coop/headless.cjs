// Only the browser presentation surface is stubbed. Game components, schemas,
// placement, belt paths, systems, hub goals and analytics run their real code.
const assert = require("node:assert/strict");
global.window = { addEventListener() {}, assert: (condition, message) => assert.ok(condition, message) };
Object.defineProperty(global, "navigator", {
    value: { userAgentData: { mobile: false } },
    configurable: true,
});
global.document = { documentElement: { style: {} } };
global.localStorage = {
    getItem() {
        return null;
    },
};
Math.radians = degrees => (degrees * Math.PI) / 180;
Math.degrees = radians => (radians * 180) / Math.PI;
