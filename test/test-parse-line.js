var parseMessage  = require('../lib/parse_message').default;
var test = require('tape');

var testHelpers = require('./helpers');

test('irc.parseMessage', function(t) {
    var checks = testHelpers.getFixtures('parse-line');

    Object.keys(checks).forEach(function(line) {
        var stripColors = false;
        if (Object.prototype.hasOwnProperty.call(checks[line], 'stripColors')) {
            stripColors = checks[line].stripColors;
            delete checks[line].stripColors;
        }
        t.deepEqual(
            checks[line],
            parseMessage(line, stripColors),
            line + ' parses correctly'
        );
    });
    t.end();
});
