import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClosing } from '../../agent/closing.ts';

test('a caller signing off is a closing, however they put it', () => {
  for (const t of ['Bye.', 'Goodbye!', 'bye bye', "That's all, thanks.", 'No, that is all.', "no that's it thank you",
    "I'm done.", 'Okay, thanks, bye.', 'You can end the call.', 'End the call please', 'hang up', 'nothing else, cheers',
    'Thank you so much, goodbye', "No that's everything, have a good day", 'alright see you', "that’s all for today"]) {
    assert.equal(isClosing(t), true, t);
  }
});

test('a question or a request that happens to contain a sign-off word is not a closing', () => {
  for (const t of ["That's all I have, what's the fee?", 'Thank you', 'Thanks, and where is my payout?', 'Bye the way, my payout is late',
    'Can you end the dispute on TXN-9001?', 'I want to stop a payment', 'no', 'okay', 'My transfer said goodbye to 500 dollars',
    'Hi', '']) {
    assert.equal(isClosing(t), false, t);
  }
});
