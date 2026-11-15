// Ícones do app: SVG em linha, grade de 24 px, traço de 1,75 com pontas redondas.
//
//   icon('wifi')                         -> <svg> de 24 px, decorativo (aria-hidden)
//   icon('lock', { size: 16 })           -> menor (o traço acompanha)
//   icon('warning', { label: 'Atenção' }) -> com nome para leitores de tela
//   ICON_NAMES                           -> lista de todos os nomes
//   makeIcon(parts, options)             -> para desenhar um ícone próprio no mesmo estilo
//
// A cor é a do texto em volta (currentColor). Os elementos são criados com
// createElementNS: nada aqui passa por innerHTML.
//
// Cada ícone é uma lista de partes:
//   'M…'                    caminho (só traço)
//   ['c', cx, cy, r]        círculo
//   ['r', x, y, w, h, rx]   retângulo
//   ['d', cx, cy, r]        ponto cheio
//   ['f', 'M…']             caminho cheio

const NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  // --- navegação -----------------------------------------------------------
  wifi: ['M1.42 9a16 16 0 0 1 21.16 0', 'M5 12.55a11 11 0 0 1 14.08 0', 'M8.53 16.11a6 6 0 0 1 6.95 0', ['d', 12, 20, 1.15]],
  channels: ['M2.5 20h19', 'M3.5 20C6 20 6 7.5 9 7.5S12 20 14.5 20', 'M11.5 20c2 0 2.2-7.5 4.5-7.5s2.5 7.5 4.5 7.5'],
  trophy: [
    'M6 9H4.5a2.5 2.5 0 0 1 0-5H6',
    'M18 9h1.5a2.5 2.5 0 0 0 0-5H18',
    'M4 22h16',
    'M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22',
    'M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22',
    'M18 2H6v7a6 6 0 0 0 12 0V2Z',
  ],
  cube: [
    'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z',
    'M3.27 6.96 12 12.01l8.73-5.05',
    'M12 22.08V12',
  ],
  tools: [
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  ],
  home: ['M3 10l9-7.5 9 7.5v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9.5 21.5V13h5v8.5'],

  // --- setas e controles ---------------------------------------------------
  'chevron-right': ['M9 18l6-6-6-6'],
  'chevron-left': ['M15 18l-6-6 6-6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-up': ['M18 15l-6-6-6 6'],
  'arrow-left': ['M19 12H5', 'M12 19l-7-7 7-7'],
  'arrow-right': ['M5 12h14', 'M12 5l7 7-7 7'],
  'arrow-up': ['M12 19V5', 'M5 12l7-7 7 7'],
  'arrow-down': ['M12 5v14', 'M19 12l-7 7-7-7'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  check: ['M20 6 9 17l-5-5'],
  more: [
    ['d', 12, 5, 1.4],
    ['d', 12, 12, 1.4],
    ['d', 12, 19, 1.4],
  ],
  refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
  undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13'],
  play: ['M7 4.5v15a1 1 0 0 0 1.52.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z'],
  pause: [
    ['r', 6, 4, 4, 16, 1.2],
    ['r', 14, 4, 4, 16, 1.2],
  ],
  stop: [['r', 5, 5, 14, 14, 2.5]],
  search: [['c', 11, 11, 7.5], 'M21 21l-4.6-4.6'],
  filter: ['M3 5h18', 'M6.5 12h11', 'M10 19h4'],
  sort: ['M7 4v16', 'M3.5 16.5 7 20l3.5-3.5', 'M17 20V4', 'M13.5 7.5 17 4l3.5 3.5'],
  grid: [
    ['r', 3, 3, 7.5, 7.5, 1.5],
    ['r', 13.5, 3, 7.5, 7.5, 1.5],
    ['r', 13.5, 13.5, 7.5, 7.5, 1.5],
    ['r', 3, 13.5, 7.5, 7.5, 1.5],
  ],
  list: ['M8.5 6H21', 'M8.5 12H21', 'M8.5 18H21', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
  maximize: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M16 21h3a2 2 0 0 0 2-2v-3', 'M3 16v3a2 2 0 0 0 2 2h3'],
  external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14 21 3'],

  // --- ações ---------------------------------------------------------------
  settings: [
    ['c', 12, 12, 3],
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z',
  ],
  share: [['c', 18, 5, 3], ['c', 6, 12, 3], ['c', 18, 19, 3], 'M8.59 13.51l6.83 3.98', 'M15.41 6.51 8.59 10.49'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  export: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
  save: ['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z', 'M17 21v-8H7v8', 'M7 3v5h8'],
  copy: [['r', 9, 9, 13, 13, 2], 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  edit: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  eye: ['M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z', ['c', 12, 12, 3]],
  'eye-off': [
    'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94',
    'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19',
    'M14.12 14.12a3 3 0 1 1-4.24-4.24',
    'M2 2l20 20',
  ],
  star: ['M12 2.5l2.94 5.95 6.56.96-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.96z'],
  'star-filled': [['f', 'M12 2.5l2.94 5.95 6.56.96-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.96z']],
  pin: ['M20 10c0 6.5-8 12-8 12s-8-5.5-8-12a8 8 0 0 1 16 0z', ['c', 12, 10, 3]],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],

  // --- estado --------------------------------------------------------------
  lock: [['r', 4, 11, 16, 10.5, 2.5], 'M7.5 11V7.5a4.5 4.5 0 0 1 9 0V11'],
  'lock-open': [['r', 4, 11, 16, 10.5, 2.5], 'M7.5 11V7.5a4.5 4.5 0 0 1 8.8-1.3'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  'shield-check': ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M8.5 12l2.5 2.5 4.5-5'],
  warning: [
    'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
    'M12 9v4.5',
    ['d', 12, 17.2, 1.1],
  ],
  info: [['c', 12, 12, 9.5], 'M12 16.5v-5', ['d', 12, 7.8, 1.1]],
  help: [['c', 12, 12, 9.5], 'M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.5-2.8 4', ['d', 12, 17.2, 1.1]],
  'alert-circle': [['c', 12, 12, 9.5], 'M12 7.5v5.5', ['d', 12, 16.4, 1.1]],
  'check-circle': [['c', 12, 12, 9.5], 'M8 12.3l2.7 2.7L16 9.5'],
  'x-circle': [['c', 12, 12, 9.5], 'M15 9l-6 6', 'M9 9l6 6'],
  'wifi-off': [
    'M2 2l20 20',
    'M16.72 11.06A10.94 10.94 0 0 1 19 12.55',
    'M5 12.55a10.94 10.94 0 0 1 5.17-2.39',
    'M10.71 5.05A16 16 0 0 1 22.58 9',
    'M1.42 9a15.91 15.91 0 0 1 4.7-2.88',
    'M8.53 16.11a6 6 0 0 1 6.95 0',
    ['d', 12, 20, 1.15],
  ],
  bolt: ['M13 2 3.5 13.5H12l-1 8.5 9.5-11.5H12z'],
  clock: [['c', 12, 12, 9.5], 'M12 6.5V12l3.5 2'],
  history: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7.5V12l3.5 2'],
  sparkle: [
    'M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z',
  ],

  // --- Wi-Fi e rede --------------------------------------------------------
  router: [['r', 2, 14, 20, 7.5, 2.2], 'M6 17.75h.01', 'M10 17.75h.01', 'M15 10v4', 'M17.84 7.17a4 4 0 0 0-5.66 0', 'M20.66 4.34a8 8 0 0 0-11.31 0'],
  signal: ['M3 20h.01', 'M7.5 20v-4', 'M12 20v-8', 'M16.5 20V8', 'M21 20V4'],
  antenna: [
    'M4.9 19.1C1 15.2 1 8.8 4.9 4.9',
    'M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5',
    ['c', 12, 12, 2],
    'M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5',
    'M19.1 4.9C23 8.8 23 15.1 19.1 19',
  ],
  radar: [
    'M19.07 4.93A10 10 0 0 0 6.99 3.34',
    'M4 6h.01',
    'M2.29 9.62A10 10 0 1 0 21.31 8.35',
    'M16.24 7.76A6 6 0 1 0 8.23 16.67',
    'M12 18h.01',
    'M17.99 11.66A6 6 0 0 1 15.77 16.67',
    ['c', 12, 12, 2],
    'M13.41 10.59l5.66-5.66',
  ],
  target: [
    ['c', 12, 12, 9.5],
    ['c', 12, 12, 5.5],
    ['d', 12, 12, 1.5],
  ],
  location: ['M2 12h3', 'M19 12h3', 'M12 2v3', 'M12 19v3', ['c', 12, 12, 7], ['c', 12, 12, 2.5]],
  speed: ['M12 14l4-4', 'M3.34 19a10 10 0 1 1 17.32 0'],
  ping: ['M22 12h-4l-3 8.5L9 3.5 6 12H2'],
  timeline: ['M3 3v16a2 2 0 0 0 2 2h16', 'M19 9l-5 5-4-4-3 3'],
  devices: ['M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8', 'M10 19v-4', 'M7 19h5', ['r', 16, 12, 6, 10, 1.5]],
  phone: [['r', 5.5, 2, 13, 20, 2.5], 'M12 18h.01'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  globe: [['c', 12, 12, 9.5], 'M2.5 12h19', 'M12 2.5a14.5 14.5 0 0 1 3.8 9.5 14.5 14.5 0 0 1-3.8 9.5A14.5 14.5 0 0 1 8.2 12 14.5 14.5 0 0 1 12 2.5z'],
  users: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', ['c', 9, 7, 4], 'M23 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  volume: ['M11 5 6 9H2v6h4l5 4z', 'M15.54 8.46a5 5 0 0 1 0 7.07', 'M19.07 4.93a10 10 0 0 1 0 14.14'],
  'volume-off': ['M11 5 6 9H2v6h4l5 4z', 'M22.5 9.5l-5 5', 'M17.5 9.5l5 5'],

  // --- mapa ----------------------------------------------------------------
  ruler: [
    'M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0z',
    'M14.5 12.5l2-2',
    'M11.5 9.5l2-2',
    'M8.5 6.5l2-2',
    'M17.5 15.5l2-2',
  ],
  layers: ['M12 2.5 2.5 7.25 12 12l9.5-4.75z', 'M2.5 16.75 12 21.5l9.5-4.75', 'M2.5 12 12 16.75 21.5 12'],
  'floor-up': ['M3 21h5v-4h4v-4h4V9h5', 'M6.5 12V4', 'M3.5 7l3-3 3 3'],
  'floor-down': ['M3 21h5v-4h4v-4h4V9h5', 'M6.5 4v8', 'M3.5 9l3 3 3-3'],
  walk: [
    'M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0z',
    'M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0z',
    'M16 17h4',
    'M4 13h4',
  ],
  route: [['c', 6, 19, 3], 'M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15', ['c', 18, 5, 3]],
  compass: [['c', 12, 12, 9.5], 'M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36z'],
  'rotate-3d': [
    'M16.47 7.5C15.64 4.24 13.95 2 12 2 9.24 2 7 6.48 7 12s2.24 10 5 10c.34 0 .68-.07 1-.2',
    'M15.19 13.71l3.82 1.86-1.86 3.81',
    'M19 15.57c-1.8.89-4.27 1.43-7 1.43-5.52 0-10-2.24-10-5s4.48-5 10-5c4.84 0 8.87 1.72 9.8 4',
  ],
  move: ['M5 9l-3 3 3 3', 'M9 5l3-3 3 3', 'M15 19l-3 3-3-3', 'M19 9l3 3-3 3', 'M2 12h20', 'M12 2v20'],
  'zoom-in': [['c', 11, 11, 7.5], 'M21 21l-4.6-4.6', 'M11 8v6', 'M8 11h6'],
  'zoom-out': [['c', 11, 11, 7.5], 'M21 21l-4.6-4.6', 'M8 11h6'],
  building: [
    ['r', 4.5, 2.5, 15, 19, 2],
    'M9.5 21.5v-4h5v4',
    'M8.5 7h.01',
    'M12 7h.01',
    'M15.5 7h.01',
    'M8.5 11h.01',
    'M12 11h.01',
    'M15.5 11h.01',
  ],

  // --- aparência -----------------------------------------------------------
  sun: [
    ['c', 12, 12, 4],
    'M12 2v2',
    'M12 20v2',
    'M4.93 4.93l1.41 1.41',
    'M17.66 17.66l1.41 1.41',
    'M2 12h2',
    'M20 12h2',
    'M6.34 17.66l-1.41 1.41',
    'M19.07 4.93l-1.41 1.41',
  ],
  moon: ['M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7z'],
  contrast: [['c', 12, 12, 9.5], ['f', 'M12 2.5a9.5 9.5 0 0 1 0 19z']],
  flask: [
    'M10 2v7.53a2 2 0 0 1-.21.9L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.07-10.12a2 2 0 0 1-.21-.9V2',
    'M8.5 2h7',
    'M7 16h10',
  ],
};

/** Todos os nomes aceitos por icon(). */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const key in attrs) el.setAttribute(key, String(attrs[key]));
  return el;
}

/**
 * Monta um <svg> no estilo do app a partir de uma lista de partes (veja o cabeçalho).
 * @param {(string|Array)[]} parts
 * @param {{size?:number, label?:string, class?:string, stroke?:number}} [options]
 * @returns {SVGSVGElement}
 */
export function makeIcon(parts, options = {}) {
  const size = Number.isFinite(options.size) ? options.size : 24;
  const svg = svgEl('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    // em tamanhos pequenos o traço engrossa um pouco para não sumir
    'stroke-width': Number.isFinite(options.stroke) ? options.stroke : size < 20 ? 2 : 1.75,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  svg.setAttribute('class', options.class ? `icon ${options.class}` : 'icon');
  if (options.label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  for (const part of parts) {
    if (typeof part === 'string') {
      svg.appendChild(svgEl('path', { d: part }));
      continue;
    }
    const [kind, a, b, c, d, e] = part;
    if (kind === 'c') svg.appendChild(svgEl('circle', { cx: a, cy: b, r: c }));
    else if (kind === 'r') svg.appendChild(svgEl('rect', { x: a, y: b, width: c, height: d, rx: e ?? 0 }));
    else if (kind === 'd') svg.appendChild(svgEl('circle', { cx: a, cy: b, r: c, fill: 'currentColor', stroke: 'none' }));
    else if (kind === 'f') svg.appendChild(svgEl('path', { d: a, fill: 'currentColor' }));
  }
  return svg;
}

const warned = new Set();

/**
 * Ícone pelo nome. Nome desconhecido devolve um círculo neutro (e avisa uma vez no console),
 * para que um erro de digitação não derrube a tela.
 * @param {string} name  um de ICON_NAMES
 * @param {{size?:number, label?:string, class?:string, stroke?:number}} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, options) {
  let parts = ICONS[name];
  if (!parts) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[icons] ícone desconhecido: ${name}`);
    }
    parts = [['c', 12, 12, 9.5]];
  }
  return makeIcon(parts, options);
}
