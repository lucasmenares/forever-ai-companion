// Items in the AI's answers: {{item:ID|Name}} marks, made into links in the game.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystem, cleanAnswer, plainAnswer } from '../src/prompt.js';

test('the AI is told to mark items it saw in the data, never invented ones', () => {
  const system = buildSystem('', 'fizzi', { lang: 'es' });
  assert.match(system, /\{\{item:ITEMID\|Name\}\}/);
  assert.match(system, /Never make up or guess an id/);
});

test('the AI is told to mark places with coordinates, never invented ones', () => {
  const system = buildSystem('', 'rizzik', { lang: 'de' });
  assert.match(system, /\{\{way:Zone\|X\|Y\|Name\}\}/);
  assert.match(system, /never invent coordinates/);
});

test('place marks survive the answer cleanup and read as "Name (X, Y)" outside the game', () => {
  const answer = cleanAnswer('Geh zu **Rok Orhan** {{way:Feralas|73.6|45.0|Rok Orhan}} oder {{way:Feralas|75|44.2|}}.');
  assert.equal(answer, 'Geh zu Rok Orhan {{way:Feralas|73.6|45.0|Rok Orhan}} oder {{way:Feralas|75|44.2|}}.');
  assert.equal(plainAnswer(answer), 'Geh zu Rok Orhan Rok Orhan (73.6, 45.0) oder Feralas (75.0, 44.2).');
  assert.equal(plainAnswer('{{way:Feralas|x|y|Ort}} {{way:Feralas||45|Ort}}'), 'Feralas|x|y|Ort Feralas||45|Ort',
    'a broken mark is not dropped, just shown as it is');
});

test('item marks survive the answer cleanup and read as [Name] outside the game', () => {
  const answer = cleanAnswer('**Equípate** {{item:9999|Anillo del alba}} y vende {{item:858|Poción de sanación inferior}}.');
  assert.equal(answer, 'Equípate {{item:9999|Anillo del alba}} y vende {{item:858|Poción de sanación inferior}}.');
  assert.equal(plainAnswer(answer), 'Equípate [Anillo del alba] y vende [Poción de sanación inferior].');
  assert.equal(plainAnswer('sin objetos {llaves}'), 'sin objetos {llaves}');
});
