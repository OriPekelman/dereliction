// Entry for the all-in-one build: matter-js + html2canvas + the library in one file.
import Matter from 'matter-js';
import html2canvas from 'html2canvas';
globalThis.Matter = globalThis.Matter || Matter;
globalThis.html2canvas = globalThis.html2canvas || html2canvas;
import './physical-web.js';
