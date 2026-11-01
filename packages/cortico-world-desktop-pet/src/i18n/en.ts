/**
 * English: the text this World shows people. The keys are zh.ts's; a language other than zh-Hant
 * reads the top-level keys its file leaves out from here. Bubbles, the menu and voice hints follow the
 * app language; the console's settings, panels, chat page and prompt notes follow the console
 * request's language. Text the bot reads is not here (model-text.ts).
 */
import type { PetText } from './index.ts';

const en: PetText = {
  /** What events and bubbles call the person while no name is set. */
  defaultUser: 'Pal',

  /** The pet's menu and bubbles. */
  menu: {
    /** The power button's name when the app gives none. */
    quit: 'Quit',
    /** The question in the menu header after the power button is clicked. */
    quitPrompt: (label: string) => `${label}?`,
  },

  /** Status bubble: a tool call without its own description. */
  busy: 'Working',

  /** Voice input: the microphone button's state in the menu, and the notes in the introduction and on the settings page. */
  voice: {
    notRunning: 'Speech recognition is not running',
    badKey: (hotkey: string) => `Unknown key "${hotkey}"`,
    keyProblem: (problem: string) => `The talk key is unavailable, so speech is not recognized for now: ${problem}`,
    always: 'Always listening: just talk',
    holdTaps: (key: string, taps: number) => `Tap ${key} ${taps === 2 ? 'once' : 'twice'}, then hold it and talk; let go to send`,
    hold: (key: string) => `Hold ${key} and talk; let go to send`,
    /** A line in the Voice input page's results for a sentence that was not recognized. */
    failedLine: (error: string) => `[failed] ${error}`,
  },

  /** Names of the talk keys, by their Windows key names; the Mac set goes over them. */
  keys: {
    LeftCtrl: 'Left Ctrl', RightCtrl: 'Right Ctrl', LeftAlt: 'Left Alt', RightAlt: 'Right Alt', LeftShift: 'Left Shift', RightShift: 'Right Shift',
    RightWin: 'Right Win', Backquote: '`', Mouse3: 'Middle mouse button', Mouse4: 'Mouse button 4', Mouse5: 'Mouse button 5',
  },
  macKeys: {
    Ctrl: 'Control', LeftCtrl: 'Left Control', RightCtrl: 'Right Control',
    Alt: 'Option', LeftAlt: 'Left Option', RightAlt: 'Right Option', Win: 'Command', RightWin: 'Right Command',
  },
  /** Repeated presses, put before the key name: "Double-press Left Alt". */
  taps: (taps: number, keys: string) => `${taps === 2 ? 'Double' : 'Triple'}-press ${keys}`,

  /** Why the talk key cannot be read. */
  hotkey: {
    cannotRead: (why: string) => `Cannot read the keyboard: ${why}`,
    macNoKey: 'A Mac keyboard has no such key; pick another talk key',
    macPermission: 'No Input Monitoring permission: turn Coopanion on under System Settings → Privacy & Security → Input Monitoring, then restart it. If it is on already, remove Coopanion from the list with "−" and add it back: an updated version does not inherit the old permission',
    linuxNoKey: 'Linux cannot read this key (mouse side buttons do not work); pick another talk key',
    linuxNoDisplay: 'The talk key needs X11 (or XWayland) on Linux: DISPLAY is not set',
    linuxNoX11: 'The talk key cannot connect to the X11 display',
    unsupported: 'The talk key works on Windows, macOS and Linux only',
  },
  /** Why the typing key cannot be read; the other two reasons (the keyboard, Input Monitoring) are the ones in `hotkey`. */
  typeKey: {
    macNoKey: 'A Mac keyboard has no such key; pick another typing key',
    linuxNoKey: 'Linux cannot read this key (mouse side buttons do not work); pick another typing key',
    linuxNoDisplay: 'The typing key needs X11 (or XWayland) on Linux: DISPLAY is not set',
    linuxNoX11: 'The typing key cannot connect to the X11 display',
    unsupported: 'The typing key works on Windows, macOS and Linux only',
  },

  /** Volcengine's Doubao (engine doubao): one API Key for recognition and synthesis. */
  doubao: {
    noKey: 'The Doubao API Key is not set',
    badUrl: (url: string) => `The Doubao address is not a ws or wss URL: ${url}`,
    notRunning: 'Doubao recognition is not started',
    connect: (why: string) => `Cannot reach Doubao: ${why}`,
    closed: 'Doubao closed the connection',
    failed: (code: number, why: string) => `Doubao answered with error ${code}: ${why}`,
    badFrame: (why: string) => `Doubao sent something that cannot be read: ${why}`,
    noText: 'Doubao heard no words',
    gone: 'That line is no longer waiting to be read',
  },

  /** The wake word, heard by a local KeywordSpotter. */
  wake: {
    noWords: 'No wake word is written yet',
    incomplete: 'The wake word model is incomplete, download it again',
    loadFailed: (why: string) => `The wake word model could not be loaded: ${why}`,
    unknownTokens: (what: string) => `The model's word table has no ${what}. Write it in pinyin, a syllable's initial and final apart.`,
    notListening: 'The wake word is not listening',
    paused: 'The wake word kept failing, so it is resting for a while',
    group: 'Wake word',
    enabled: {
      title: 'Wake it by name',
      description: 'On, and hearing the word in the microphone starts Coo listening without the talk key; heard here, with no audio sent anywhere',
    },
    keywords: {
      title: 'Words that wake it',
      description: 'One a line, in the model\'s pinyin: initials and finals spaced apart, and after @ the words you read. "x iǎo k ě @小可" wakes on 小可',
    },
    threshold: {
      title: 'Sensitivity',
      description: 'Lower wakes more easily and on other sounds too; the default is 0.25',
    },
    cooldownMs: { title: 'Between two wakes' },
    model: 'Wake word model',
    words: (words: string) => `It answers to: ${words}`,
    hint: 'One wake word a line',
  },

  /** Downloading the window runtime and the wake word model. */
  store: {
    noBuild: (platform: string) => `No prebuilt package for ${platform}`,
    downloading: (file: string) => `Downloading ${file}`,
    unpacking: 'Unpacking',
    downloadingWake: 'Downloading the wake word model',
    downloadingFrom: (file: string, host: string) => `Downloading ${file} (${host})`,
    failed: (file: string, why: string) => `${file} failed to download (${why})`,
    exitCode: (cmd: string, code: number | null, out: string) => `${cmd} exit code ${code}: ${out}`,
  },

  /** Why a pack's figure.json cannot be read; field names as written there. */
  packs: {
    noManifest: (file: string) => `No ${file}`,
    badJson: (file: string, why: string) => `${file} is not valid JSON: ${why}`,
    notInteger: (key: string, got: string) => `${key} must be an integer, not ${got}`,
    tooNew: (key: string, v: number, now: number) => `${key} is ${v}; this version reads up to ${now}: update the app first`,
    tooOld: (key: string, v: number, oldest: number) => `${key} ${v} is a test format from before ${oldest} and cannot be read`,
    badId: (got: string) => `Invalid id: ${got}`,
    noName: 'name is missing',
    noAbout: 'about is missing',
    badEntry: 'entry or export is invalid',
    badModel: 'The model path is invalid',
    badThumb: 'The thumb path is invalid',
    badAxis: (got: string) => `Invalid entry in axes: ${got}`,
    badOption: (axis: string, got: string) => `Invalid option in axes.${axis}: ${got}`,
    badPreset: (got: string) => `Invalid entry in presets: ${got}`,
    presetMissing: (preset: string, axis: string) => `presets.${preset} picks no option for ${axis}`,
    vocabNotArray: 'vocab must be an array',
    badWordId: (got: string) => `Invalid id in vocab: ${got}`,
    unknownKind: (id: string, kind: string) => `vocab.${id}.kind is ${kind}, which this version does not know; the bot does not get this word`,
    namesNotArray: (id: string, lang: string) => `vocab.${id}.names.${lang} must be an array`,
    badWordName: (id: string, got: string) => `Invalid name in vocab.${id}: ${got}`,
    nameTaken: (name: string) => `${name} names more than one word in vocab`,
    noWordAbout: (id: string) => `vocab.${id}.about is missing`,
    badSeconds: (id: string) => `vocab.${id}.seconds must be a positive number`,
    soundsNotObject: 'sounds must be an object',
    badSoundName: (got: string) => `Invalid name in sounds: ${got}`,
    badSoundFile: (name: string) => `sounds.${name}.file must be a file in the pack`,
    badVolume: (name: string) => `sounds.${name}.volume must be 0–1`,
    soundType: (name: string, file: string) => `${file} of sounds.${name} is not an .ogg, .mp3 or .wav this version plays; the sound stays silent`,
    soundKind: (name: string, kind: string, kinds: readonly string[]) => `sounds.${name}.kind is ${kind}; this version knows ${kinds.join(', ')} only, so the sound stays silent`,
    soundMissing: (name: string, file: string) => `${file} of sounds.${name} does not exist; the sound stays silent`,
    badWalk: (got: string) => `can.walk is ${got}, which this version does not know; taken as able to walk`,
    movesNotArray: 'moves must be an array',
    tooManyMoves: (max: number) => `moves holds at most ${max} targets`,
    badMoveId: (got: string) => `Invalid id in moves: ${got} (left, center, right, cursor and numbers are the default targets)`,
    moveTaken: (id: string) => `${id} appears more than once in moves`,
    noMoveText: (id: string) => `moves.${id} has no name or about`,
    badMoveParams: (id: string, max: number) => `moves.${id}.params must be an array of at most ${max}, each with an id, an about, and numbers min below max`,
    needsNotArray: 'needs must be an array',
    unknownNeed: (got: string) => `${got} in needs is not provided by this version and is left out`,
    idTaken: (id: string, builtin: boolean) => `id ${id} is taken by ${builtin ? 'a built-in figure' : 'another pack'}`,
  },

  /** Importing packs on the dressing page. */
  importing: {
    badZip: (why: string) => `Not a readable zip: ${why}`,
    tooBig: (mb: number) => `Over ${mb} MB unpacked`,
    truncated: 'The upload is incomplete',
    badPath: (path: string) => `A path cannot be used: ${path}`,
    builtinId: (id: string) => `id ${id} belongs to a built-in figure; change the id to import it`,
    duplicateId: (id: string) => `id ${id} is the same as another pack in this import`,
    unpackFailed: (why: string) => `Could not unpack: ${why}`,
    expired: 'This import has expired; choose the files again',
    noneChosen: 'No pack is chosen',
    zipOrFolder: 'Only a zip or folders can be imported',
    overLimit: (mb: number) => `Over ${mb} MB`,
  },

  /** Uninstalling packs on the dressing page. */
  removing: {
    notInstalled: (id: string) => `No figure pack has id ${id}`,
    builtin: (id: string) => `${id} is a built-in figure and cannot be uninstalled`,
    elsewhere: (id: string) => `${id} is not in the figure pack installation folder and cannot be uninstalled here`,
    failed: (why: string) => `Could not delete it: ${why}`,
  },

  /** The bubble in which the pet asks the person's consent to a change of settings: the question, its three buttons, and how each change is said */
  consent: {
    question: (items: string[]) => `Can I ${items.join(', ')}?`,
    /** OK / Always OK (these items are not asked about again) / No thanks */
    choices: ['OK', 'Always OK', 'No thanks'] as [yes: string, always: string, no: string],
    list: (items: string[]) => items.join(', '),
    pick: (axis: string, option: string) => `${axis}: ${option}`,
    figure: (to: string) => `switch to ${to}`,
    scheme: (figure: string, look: string) => `put on a different ${figure} look (${look})`,
    roam: { free: 'Often', calm: 'Now and then', off: 'Stay put' } as Record<'free' | 'calm' | 'off', string>,
    roamTo: (to: string) => `set my walking to "${to}"`,
    snore: (seconds: number) => (seconds === 0 ? 'snore until I wake' : `snore for ${seconds} s each time I sleep`),
    sound: (on: boolean) => (on ? 'turn sounds on' : 'turn sounds off'),
    scale: (from: number, to: number) => `change my size from ${from}× to ${to}×`,
    bubbleSize: (from: number, to: number) => `change the bubble size from ${from}× to ${to}×`,
    fontSize: (from: number, to: number) => `change the text size from ${from}× to ${to}×`,
    theme: { dark: 'switch to the night look', light: 'switch to the day look' } as Record<'dark' | 'light', string>,
    hover: (list: string) => `change the hover buttons to ${list}`,
    actions: { chat: 'Type', voice: 'Voice input', roam: 'Walking', theme: 'Night mode', sound: 'Sounds', dress: 'Dress up', hide: 'Hide pet' } as Record<string, string>,
    user: (to: string) => `call you "${to}"`,
  },

  /** Why the World fails to start when every page port is taken. */
  portsTaken: (from: number, to: number, why: string) => `Ports ${from}–${to} are all taken: ${why}`,

  /** The console: the World page's lamps, links, panels and prompt notes. */
  console: {
    label: 'Desktop pet',
    window: 'Pet window',
    connected: 'Page connected',
    notOpen: 'Not open',
    /** The window lamp while the page in the window reported that no figure would draw. */
    noBody: (reason: string) => `Page connected, the figure cannot be drawn: ${reason}`,
    /** The window lamp's hint when a browser page stands in for the window. */
    alsoBrowser: (hint: string) => `${hint}; a browser page is connected`,
    voice: 'Speech recognition',
    notStarted: 'Not started',
    viewInBrowser: 'View the pet in the browser',
    dress: 'Dress up',
    panels: {
      pet: { title: 'Desktop pet', description: 'The window, the dress and the window runtime.' },
      voice: { title: 'Voice', description: 'The recognition service, input level and what was heard, reading replies aloud and the wake word.' },
    },
    envPrompt: { title: 'Desktop pet environment', description: "Describes the pet's body, four tools and input events." },
    vars: {
      'pet.user': 'What the bot calls the person',
      'pet.vocab': "The current figure's expressions and motions",
      'pet.moves': "The current figure's own pet_move_to targets; empty when it has none",
      'pet.voice': 'Whether voice input is on or off, and, while replies are read aloud, that they must sound right spoken',
      'pet.body': 'What the current figure looks like',
      'pet.dress': 'The figures and dress pet_set can pick',
      'pet.self': 'Self-adjustment: which settings change directly, which wait for consent, or that none can change',
      'pet.chat': 'A note on the chat page when the app has one; empty otherwise',
      'pet.reply': 'A line telling the bot which language to talk in when the app language is neither Simplified Chinese nor English; empty otherwise',
      'pet.cua': 'The computer use part: screenshot coordinates, when the person is asked first, and staying out of their way; empty while computer use is off',
    },
    noGuide: 'This app has no introduction',
    unknownMethod: (name: string) => `Unknown method ${name}`,
  },

  /** The console's settings (the World page and settings in advanced mode). */
  config: {
    group: 'Desktop pet',
    soundGroup: 'Sounds',
    asrGroup: 'Voice',
    user: { title: 'Your name', description: (max: number) => `The name voice, typing and touch events call you by, up to ${max} characters. Empty uses the default name.` },
    roam: { title: 'Walking', description: 'free walks about often; calm stays put most of the time; off moves only when asked.' },
    theme: { title: 'Night mode', description: 'dark is night: a light body and dark bubbles; light is day: a dark body and light bubbles.' },
    rememberPosition: { title: 'Remember position', description: 'Saves how far across the screen the pet stands when the app quits, and starts there next time; with several screens Coo always starts on the main one.' },
    hoverButtons: { title: 'Hover buttons', description: (max: number, ids: string) => `Buttons beside the pet while the pointer rests on Coo, up to ${max}, separated by commas: ${ids}.` },
    doubleClickChat: { title: 'Double-click to type', description: 'Double-clicking the pet opens the typing box.' },
    statusBubble: { title: 'Status bubble', description: 'Shows what the pet is doing while Coo thinks, looks through memory or uses the computer, file names included.' },
    saidBubbles: { title: 'Input bubbles', description: 'What the person types, says or sends from the chat page shows above the pet until Coo replies. When off, speech shows only while it is recognized.' },
    selfAdjust: { title: 'Self-adjustment', description: 'off: Coo cannot change settings or keep quiet for a while. default: figure, dress, walking and snoring change directly; size, bubble size, text size, sounds, night mode, hover buttons and what Coo calls you wait for your consent. any: everything changes directly. custom: as ticked on the Habits page; ticked items change directly, the rest wait for your consent.' },
    windowEnabled: { title: 'Open the pet window at start' },
    scale: { title: 'Size' },
    bubbleSize: { title: 'Bubble size', description: "Width, padding, corners and tail of the pet's bubbles and yours, 1 being the default; the text keeps its size." },
    fontSize: { title: 'Text size', description: 'Size of the text in the bubbles, 1 being the default; the bubbles keep their width.' },
    bubbleSpeed: { title: 'Bubble speed', description: "How fast the pet's bubbles type out and how long they stay, 1 being the default; higher is faster." },
    glow: { title: 'Outer glow', description: "How many pixels the light glow around the pet reaches when Coo's colors match the background; 0 turns it off." },
    frameRate: { title: 'Frame rate', description: 'Frames a second while the pet walks, is carried or jumps; 0 follows the display. Above the display\'s refresh rate the display\'s rate applies. The Habits page offers 60, 120, 144 and Unlimited.' },
    lockFrameRate: { title: 'Lock frame rate', description: 'Draws the pet at the frame rate at rest too. When off, it drops to 30 frames a second while standing, sitting or asleep.' },
    hideWhenFullscreen: { title: 'Hide during full screen', description: 'When on, the pet hides while the window in front fills the screen Coo is on (a game, a full-screen video, a browser in full screen) and comes back when full screen ends; a maximized window does not count. When off, Coo always stays on top.' },
    exportOverlay: { title: 'OBS overlay', description: "Serves the pet window's picture on a transparent background at /overlay for an OBS Browser source; off, nothing is served." },
    electronFile: { title: 'Electron executable', description: 'Empty uses CORTICO_DESKTOP_PET_HOST, then the runtime installed from the panel.' },
    port: { title: 'Page port', description: 'Moves up to the next free port when taken.' },
    touchEnabled: { title: 'Touches become events', description: 'Pokes, petting, and being picked up and thrown.' },
    touchWakeOn: { title: 'Response mode', description: 'poke: only a poke gets a response right away; other touches wait for the next response. all: every touch gets one. none: every touch waits for the next response. custom: the touches ticked on the Habits page get one. After a touch gets a response, the touches until that turn ends wait for the next one.' },
    sound: { title: 'All sounds', description: "The sound button in the pet's menu flips this." },
    sounds: {
      move: { title: 'Moving', description: 'Walking, running, jumping, landing, being thrown, nodding, shaking, spinning, dizziness, shivering, dancing, looking about.' },
      touch: { title: 'Touch', description: 'Being picked up, swung, petted, poked.' },
      face: { title: 'Faces', description: 'Happy, wink, love, surprised, angry, sad, shy, yawning.' },
      snore: { title: 'Snoring', description: '' },
      talk: { title: 'Talking', description: 'The babble as bubble text appears, and choice cards popping up.' },
      ui: { title: 'Buttons and cues', description: 'Button clicks, bubbles opening, picks, and listening starting and ending.' },
    },
    snoreSeconds: { title: 'Snore length', suffix: 's', description: "In each sleep the pet goes quiet after snoring this long; the z's keep floating. 0 = snore until waking." },
    speech: { title: 'Speech', description: 'Reads out a syllable as each character appears in a bubble, in place of the Talking babble; silent while Talking sounds are off.' },
    speechPitch: { title: 'Speech pitch', description: (a: number, b: number, c: number) => `low, mid and high are ${a}, ${b} and ${c} Hz; custom uses the custom pitch.` },
    speechPitchHz: { title: 'Custom pitch' },
    speechSpeed: { title: 'Speech speed', description: (a: number, b: number, c: number) => `Most syllables a second: low, mid and high are ${a}, ${b} and ${c}; custom uses the custom speed. Slower than the text, the voice ends after the text has finished.` },
    speechRate: { title: 'Custom speed', suffix: 'syllables/s' },
    ttsGroup: 'Reading aloud',
    ttsEnabled: { title: 'Read replies aloud', description: 'Reads replies through Doubao. Only a turn asked for by voice is read, not one typed; with Sounds off nothing is read, and the syllable mumbling keeps its own switch there' },
    ttsVoice: { title: 'Voice', description: "The speaker id of Doubao's synthesis, a general female voice by default; try it with Listen once changed" },
    ttsSpeed: { title: 'Speed' },
    ttsVolume: { title: 'Volume' },
    ttsMaxChars: { title: 'Longest read', description: 'The most characters of a reply that are read; the rest is left out' },
    ttsClean: { title: 'Clean before reading', description: 'Takes out code blocks, inline code, links, emoji and long asides, so only what can be understood is read' },
    asrEnabled: { title: 'Voice input' },
    asrLanguage: { title: 'Language', description: 'An ISO 639-1 code, or auto to let Doubao judge; empty follows the app language.' },
    asrDoubaoUrl: { title: 'Doubao address', description: "Empty uses Volcengine's wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async; a test may point it at this computer. The API Key is entered on the Voice page and serves recognition and reading aloud alike." },
    asrSimplified: { title: 'Convert to Simplified', description: 'Turns Traditional characters in what was heard into Simplified while the app language is Simplified Chinese.' },
    thresholdDb: { title: 'Speech threshold' },
    silenceMs: { title: 'Silence that ends a sentence' },
    maxUtteranceMs: { title: 'Longest sentence' },
    roundSeconds: { title: 'Longest round', suffix: 's', description: 'One round of listening lasts at most this long: at its end what was heard is sent, and listening continues in the next round. Always-on listening and the wake word split into rounds of this length; letting go of the talk key ends a round.' },
  },

  /** The console's Desktop pet and Voice input panels. */
  panel: {
    pet: 'Desktop pet',
    window: 'Pet window',
    openWindow: 'Open window',
    closeWindow: 'Close window',
    runtime: 'Window runtime',
    install: 'Install',
    viewInBrowser: 'View in browser',
    dress: 'Dress up',
    dressHint: 'Changes are saved at once and reach the pet window',
    connected: 'Connected',
    starting: 'Starting',
    cannotOpen: 'Cannot open',
    notOpen: 'Not open',
    external: 'Using an external program',
    installed: 'Installed',
    downloading: (progress: string) => `Downloading ${progress}`,
    installFailed: 'Install failed',
    notInstalled: 'Not installed',
    noBuild: 'No prebuilt package for this platform',
    electronSize: 'Electron 44.4.4, about 150 MB',

    voice: 'Voice',
    more: 'More settings',
    moreTrouble: 'More settings · needs attention',
    less: 'Fewer settings',
    enable: 'Turn on voice input',
    /** Under the master switch: how a sentence starts right now, the wake word being the second way in */
    talkHint: {
      hold: (key: string) => `Hold ${key} to talk`,
      always: 'Listening all the time: pause when you finish and it answers',
      wakeHold: (key: string, word: string) => `Hold ${key} to talk, or say “${word}”`,
    },
    enabledHintOnPress: 'The microphone opens while the talk key is held and closes after release',
    disabledHint: 'Off: the microphone stays closed, and the settings below wait',
    apiUrl: 'Service address',
    apiKey: 'API Key',
    sharedKey: 'Shared with reading aloud',
    keySaved: 'Saved',
    keyMissing: 'Not set',
    server: 'Recognition service',
    ready: 'Ready',
    error: 'Error',
    stopped: 'Stopped',
    download: 'Download',
    retry: 'Retry',
    downloadFailed: 'Download failed',
    downloaded: 'Downloaded',
    notDownloaded: 'Not downloaded',
    mic: 'Microphone',
    micStates: { on: 'Listening', off: 'Not listening', denied: 'Denied', error: 'Error' },
    defaultDevice: 'System default',
    missingDevice: 'The device picked before (not found now)',
    micN: (n: number) => `Microphone ${n}`,
    mode: 'How it listens',
    modes: { hold: 'While the talk key is held', always: 'All the time' },
    openOnPress: 'Open the microphone only while held',
    openOnPressHint: 'Turn on for headsets, such as Bluetooth ones, that switch to call mode while the microphone is open; after pressing, wait a moment before speaking, or the first words may be missed',
    roundSeconds: 'Longest round (s)',
    switchOn: 'On',
    switchOff: 'Off',
    /** How the talk key is pressed, by the number of presses. */
    presses: {
      2: 'Double-press and hold',
      1: 'Just hold',
      3: 'Triple-press and hold',
    },
    capture: 'Press the new talk key: a key combination or a mouse side button… (Esc cancels)',
    listening: 'Listening',
    waitingKey: 'Waiting for the talk key',
    results: 'What was heard',
    resultsHint: 'Struck-through lines were too short or likely hallucinated, and were not sent',
    showLog: 'Show the recognized lines',
    hideLog: 'Hide the recognized lines',
    talkKeyName: 'Talk key',
    changeKey: 'Change',
    cancelKey: 'Cancel',
    level: 'Input level',
    thresholdHint: 'Only sound louder than this line counts as speech; someone else talking as loudly as you is heard too',
    noResults: 'Nothing heard yet',
    /** The reading section: its switch's row, the try-listen button and its word while making, the voice row's hint. */
    read: 'Read replies aloud',
    preview: 'Listen',
    previewing: 'Making…',
    readHint: 'Made with the same key; only a turn asked for by voice is read',
    previewSample: 'Hi there, I am Coo. Nice weather today.',
    readOff: 'Reading is not running',
  },

  /** Why the chat page's message was turned back, and its notices. */
  chat: {
    badImages: 'The images are not in a form this page sends',
    tooManyImages: (max: number) => `At most ${max} images at a time`,
    badMime: (mime: string) => `Unsupported image type ${mime}`,
    emptyImage: 'One of the images is empty',
    bigImage: (mb: number) => `Each image must be under ${mb} MB`,
    offline: 'Not connected yet',
    notSent: 'Could not send it',
    tooLate: 'That one has already been delivered and cannot be taken back.',
  },
};

export default en;
