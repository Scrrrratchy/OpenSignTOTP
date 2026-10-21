export function encodeMimeSubject(subject) {
  const value = String(subject || '').replace(/[\r\n]+/g, ' ');
  if ([...value].every(character => character.codePointAt(0) <= 127)) return value;
  const words = [];
  let chunk = '';
  for (const character of value) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 42) {
      words.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words
    .map(word => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}
