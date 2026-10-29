/**
 * What Zouve says in the chat, in the language the super admin chose in its
 * settings. `{cmd:play}` is the play command as it is typed on this server.
 */

export const LANGUAGES = ['en', 'pt', 'es'];

const TEXT = {
  en: {
    joinFirst: 'Join a voice channel first, then {cmd:play} what you want to hear.',
    usage: 'Say what to play: {cmd:play} a link, or the name of a song or an artist.',
    notFound: 'I could not find “{query}” anywhere I can play from.',
    broken: 'Searching is not working right now. The super admin can see why in my logs.',
    nowPlaying: 'Now playing: **{track}**',
    queued: 'Queued **{track}**, {position} in line.',
    queuedMany: 'Queued {count} songs, starting with **{track}**.',
    queueFull: 'The queue is full ({max} songs).',
    paused: 'Paused. {cmd:pause} again, or {cmd:play}, to carry on.',
    resumed: 'Playing again.',
    nothing: 'Nothing is playing.',
    skipped: 'Skipped **{track}**.',
    shuffled: 'Shuffled {count} songs.',
    shuffledNone: 'There is nothing in the queue to shuffle.',
    stopped: 'Stopped, and left the channel.',
    queueNow: '**Now:** {track}',
    queueNext: '**Next:**',
    queueMore: '…and {count} more.',
    queueEmpty: 'The queue is empty.',
    failed: 'Could not play **{track}** ({why}); skipping it.',
    missing: 'Could not find **{track}**; skipping it.',
    unjoinable: 'I could not join the voice channel ({why}).',
    elsewhere: 'I am playing in another channel; join it to control me.',
    removed: 'I was taken out of the voice channel, so I stopped and emptied the queue.',
  },
  pt: {
    joinFirst: 'Entre num canal de voz primeiro, depois use {cmd:play} com o que quer ouvir.',
    usage: 'Diga o que tocar: {cmd:play} um link, ou o nome de uma música ou artista.',
    notFound: 'Não encontrei “{query}” em nenhum lugar de onde eu consiga tocar.',
    broken: 'A busca não está funcionando agora. O super admin vê o motivo nos meus registros.',
    nowPlaying: 'Tocando agora: **{track}**',
    queued: '**{track}** na fila, {position}ª da vez.',
    queuedMany: '{count} músicas na fila, começando por **{track}**.',
    queueFull: 'A fila está cheia ({max} músicas).',
    paused: 'Pausado. {cmd:pause} de novo, ou {cmd:play}, para continuar.',
    resumed: 'Tocando de novo.',
    nothing: 'Nada está tocando.',
    skipped: 'Pulei **{track}**.',
    shuffled: 'Embaralhei {count} músicas.',
    shuffledNone: 'Não há nada na fila para embaralhar.',
    stopped: 'Parei, e saí do canal.',
    queueNow: '**Agora:** {track}',
    queueNext: '**Depois:**',
    queueMore: '…e mais {count}.',
    queueEmpty: 'A fila está vazia.',
    failed: 'Não consegui tocar **{track}** ({why}); pulando.',
    missing: 'Não encontrei **{track}**; pulando.',
    unjoinable: 'Não consegui entrar no canal de voz ({why}).',
    elsewhere: 'Estou tocando em outro canal; entre nele para me controlar.',
    removed: 'Fui tirado do canal de voz, então parei e esvaziei a fila.',
  },
  es: {
    joinFirst: 'Entra primero a un canal de voz y luego usa {cmd:play} con lo que quieras oír.',
    usage: 'Di qué tocar: {cmd:play} un enlace, o el nombre de una canción o artista.',
    notFound: 'No encontré “{query}” en ningún lugar desde donde pueda tocar.',
    broken: 'La búsqueda no está funcionando ahora. El super admin ve el motivo en mis registros.',
    nowPlaying: 'Sonando: **{track}**',
    queued: '**{track}** en la cola, {position}.ª en turno.',
    queuedMany: '{count} canciones en la cola, empezando por **{track}**.',
    queueFull: 'La cola está llena ({max} canciones).',
    paused: 'En pausa. {cmd:pause} otra vez, o {cmd:play}, para seguir.',
    resumed: 'Sonando de nuevo.',
    nothing: 'No está sonando nada.',
    skipped: 'Salté **{track}**.',
    shuffled: 'Mezclé {count} canciones.',
    shuffledNone: 'No hay nada en la cola para mezclar.',
    stopped: 'Paré y salí del canal.',
    queueNow: '**Ahora:** {track}',
    queueNext: '**Después:**',
    queueMore: '…y {count} más.',
    queueEmpty: 'La cola está vacía.',
    failed: 'No pude tocar **{track}** ({why}); la salto.',
    missing: 'No encontré **{track}**; la salto.',
    unjoinable: 'No pude entrar al canal de voz ({why}).',
    elsewhere: 'Estoy tocando en otro canal; entra en él para controlarme.',
    removed: 'Me sacaron del canal de voz, así que paré y vacié la cola.',
  },
};

/** A track as it is named in a message. */
export const nameOf = (track) =>
  track.artist && !track.title.toLowerCase().includes(track.artist.toLowerCase())
    ? `${track.artist} – ${track.title}`
    : track.title;

/**
 * @param {string} language
 * @param {Record<string, string>} commands canonical command → name typed here
 */
export function say(language, key, vars = {}, commands = {}) {
  const text = (TEXT[language] ?? TEXT.en)[key] ?? TEXT.en[key];
  return text
    .replace(/\{cmd:([a-z]+)\}/g, (_, c) => `!${commands[c] ?? c}`)
    .replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}
