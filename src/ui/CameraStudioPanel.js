import {
  CAMERA_STUDIO_DEFAULTS,
  CAMERA_STUDIO_PRESETS,
  normalizeCameraStudioSettings,
} from '../world/alpine/CameraStudio.js';

export const CAMERA_STUDIO_STORAGE_KEY = 'midio.cameraStudio.v1';

/** A denied storage API never prevents changing this session's camera. */
export function readCameraStudioSettings(storage) {
  try {
    return normalizeCameraStudioSettings(JSON.parse(storage?.getItem?.(CAMERA_STUDIO_STORAGE_KEY) ?? 'null'));
  } catch {
    return normalizeCameraStudioSettings(CAMERA_STUDIO_DEFAULTS);
  }
}

export function writeCameraStudioSettings(storage, settings) {
  try {
    if (typeof storage?.setItem !== 'function') return false;
    storage.setItem(CAMERA_STUDIO_STORAGE_KEY, JSON.stringify(normalizeCameraStudioSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

export function cameraStudioPanelState(settings, {
  running = false, available = true, busy = false, positionEnabled = true,
} = {}) {
  return {
    visible: settings?.enabled === true && running && available,
    disabled: busy || !available,
    positionDisabled: busy || !available || !positionEnabled,
  };
}

const FIELDS = [
  { title: 'Composition', fields: [
    { key: 'distance', label: 'Distance ×', min: 0.35, max: 1.8, step: 0.01, hint: 'Distance relative to the landscape camera.' },
    { key: 'fovDeg', label: 'Lens °', min: 15, max: 70, step: 1, hint: 'A smaller angle brings the landscape closer.' },
    { key: 'elevation', label: 'Elevation °', min: -15, max: 35, step: 1, position: true, hint: 'Height above the landscape camera angle.' },
    { key: 'azimuthDeg', label: 'Azimuth °', min: -180, max: 180, step: 1, position: true, hint: 'Starting angle around the focus point.' },
  ] },
  { title: 'Orbit', fields: [
    { key: 'direction', label: 'Direction', position: true, wide: true, options: [['cw', 'Clockwise'], ['ccw', 'Counterclockwise']] },
    { key: 'orbitSeconds', label: 'Revolution sec', min: 20, max: 240, step: 1, position: true, hint: 'Seconds for one full revolution.' },
  ] },
  { title: 'Focus', fields: [
    { key: 'focusX', label: 'X · left / right %', min: -20, max: 20, step: 1, scale: 100, position: true, hint: 'Offset as a percentage of camera distance.' },
    { key: 'focusY', label: 'Y · down / up %', min: -20, max: 20, step: 1, scale: 100, position: true, hint: 'Offset as a percentage of camera distance.' },
    { key: 'focusZ', label: 'Z · near / far %', min: -20, max: 20, step: 1, scale: 100, position: true, hint: 'Offset as a percentage of camera distance.' },
  ] },
  { title: 'Move & settle', fields: [
    { key: 'durationSec', label: 'Travel sec', min: 1, max: 30, step: 0.5 },
    { key: 'holdSec', label: 'Hold sec', min: 0, max: 12, step: 0.5 },
    { key: 'delaySec', label: 'Start delay sec', min: 0, max: 10, step: 0.5 },
    { key: 'overshoot', label: 'Overshoot %', min: 0, max: 50, step: 1, scale: 100, hint: 'How far the camera moves past its target before settling.' },
  ] },
];

const stopPropagation = event => event.stopPropagation();

/** Stationary DOM chrome. The scene canvas remains the only capture surface. */
export class CameraStudioPanel {
  constructor({
    document: suppliedDocument, settingsParent, hudParent, settings,
    onChange = () => {}, onRecenter = null,
  } = {}) {
    this.document = suppliedDocument || settingsParent?.ownerDocument || hudParent?.ownerDocument || globalThis.document;
    this.settings = normalizeCameraStudioSettings(settings);
    this.state = { running: false, available: true, busy: false, positionEnabled: true, status: '' };
    this.onChange = onChange;
    this.onRecenter = onRecenter;
    this.inputs = new Map();
    this.presetButtons = new Map();
    this.collapsed = false;

    this.setting = this._element('div', 'cameraStudioSetting');
    const settingLabel = this._element('label', 'cameraStudioSettingLabel');
    this.toggle = this._element('input');
    this.toggle.type = 'checkbox';
    this.toggle.id = 'camera-studio-toggle';
    this.toggle.setAttribute('aria-describedby', 'camera-studio-setting-hint');
    settingLabel.append(this.toggle, this._element('span', '', 'Camera Studio'));
    const settingHint = this._element('p', 'hint', 'Keep live camera controls on screen. Your choices are remembered.');
    settingHint.id = 'camera-studio-setting-hint';
    this.setting.append(settingLabel, settingHint);
    settingsParent?.append(this.setting);
    this.toggle.addEventListener('change', () => this._change({ enabled: this.toggle.checked }));

    this.element = this._element('section', 'cameraStudioPanel');
    this.element.id = 'camera-studio-panel';
    this.element.setAttribute('aria-labelledby', 'camera-studio-heading');
    this.element.hidden = true;
    const header = this._element('header', 'cameraStudioHeader');
    const heading = this._element('h2', '', 'Camera Studio');
    heading.id = 'camera-studio-heading';
    const headerActions = this._element('div', 'cameraStudioHeaderActions');
    const enableLabel = this._element('label', 'cameraStudioEnabled');
    this.enable = this._element('input');
    this.enable.type = 'checkbox';
    this.enable.setAttribute('role', 'switch');
    this.enable.setAttribute('aria-label', 'Camera Studio enabled');
    this.enable.addEventListener('change', () => this._change({ enabled: this.enable.checked }));
    enableLabel.append(this.enable, this._element('span', '', 'On'));
    this.collapseButton = this._button('Hide controls', () => {
      this.collapsed = !this.collapsed;
      this._renderState();
    });
    this.collapseButton.classList.add('cameraStudioCollapse');
    this.collapseButton.setAttribute('aria-controls', 'camera-studio-controls');
    headerActions.append(enableLabel, this.collapseButton);
    header.append(heading, headerActions);

    this.body = this._element('div', 'cameraStudioBody');
    this.body.id = 'camera-studio-controls';
    this.status = this._element('p', 'cameraStudioStatus');
    this.status.id = 'camera-studio-status';
    this.status.setAttribute('role', 'status');
    this.element.setAttribute('aria-describedby', this.status.id);
    this.body.append(this.status);
    const presets = this._element('div', 'cameraStudioPresets');
    presets.setAttribute('role', 'group');
    presets.setAttribute('aria-label', 'Camera motion preset');
    for (const preset of CAMERA_STUDIO_PRESETS) {
      const button = this._button(preset.label, () => this._change({ preset: preset.id }));
      button.dataset.preset = preset.id;
      button.title = preset.description;
      this.presetButtons.set(preset.id, button);
      presets.append(button);
    }
    this.presetDescription = this._element('p', 'cameraStudioPresetDescription');
    this.body.append(presets, this.presetDescription);
    for (const group of FIELDS) this.body.append(this._fieldGroup(group));

    const actions = this._element('div', 'cameraStudioActions');
    this.resetButton = this._button('Reset camera', () => this._change({ ...CAMERA_STUDIO_DEFAULTS, enabled: this.settings.enabled }));
    actions.append(this.resetButton);
    if (onRecenter) {
      this.recenterButton = this._button('Restart move', () => this.onRecenter());
      actions.append(this.recenterButton);
    }
    this.body.append(actions);
    this.element.append(header, this.body);
    // Keep this overlay independent of #hud's idle fade and visibility.
    const parent = hudParent?.id === 'hud' ? hudParent.parentElement : hudParent;
    (parent || this.document.body).append(this.element);
    // Form keyboard/pointer events must never reach canvas transport shortcuts.
    for (const element of [this.element, this.setting]) {
      for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'wheel']) {
        element.addEventListener(type, stopPropagation);
      }
    }
    this.setSettings(this.settings);
  }

  _element(tag, className = '', text = '') {
    const element = this.document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  _button(text, handler) {
    const button = this._element('button', 'ghostbtn', text);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  }

  _fieldGroup({ title, fields }) {
    const group = this._element('fieldset', 'cameraStudioGroup');
    group.append(this._element('legend', '', title));
    const grid = this._element('div', 'cameraStudioFields');
    for (const field of fields) {
      const label = this._element('label', 'cameraStudioField');
      if (field.wide) label.classList.add('cameraStudioFieldWide');
      const input = this._element(field.options ? 'select' : 'input');
      input.id = `camera-studio-${field.key}`;
      input.name = field.key;
      if (field.options) {
        for (const [value, text] of field.options) {
          const option = this._element('option', '', text);
          option.value = value;
          input.append(option);
        }
      } else {
        input.type = 'number';
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = String(field.step);
        input.inputMode = 'decimal';
      }
      if (field.hint) input.title = field.hint;
      const update = () => {
        if (!field.options && input.value.trim() === '') return;
        const value = field.options ? input.value : Number(input.value) / (field.scale || 1);
        if (!field.options && !Number.isFinite(value)) return;
        this._change({ [field.key]: value });
      };
      input.addEventListener('input', update);
      input.addEventListener('change', () => {
        update();
        this._syncInput(input, field);
      });
      label.append(this._element('span', '', field.label), input);
      grid.append(label);
      this.inputs.set(field.key, { input, field });
    }
    group.append(grid);
    return group;
  }

  _syncInput(input, field) {
    const value = field.options ? this.settings[field.key] : String(Number((this.settings[field.key] * (field.scale || 1)).toFixed(3)));
    if (input.value !== value) input.value = value;
  }

  _change(patch) {
    const previous = this.settings;
    this.setSettings({ ...this.settings, ...patch });
    if (Object.keys(this.settings).some(key => this.settings[key] !== previous[key])) this.onChange({ ...this.settings });
  }

  setSettings(settings) {
    this.settings = normalizeCameraStudioSettings(settings);
    this.toggle.checked = this.settings.enabled;
    this.enable.checked = this.settings.enabled;
    for (const { input, field } of this.inputs.values()) {
      // Let a listener finish a decimal/negative value before normalizing the text.
      if (this.document.activeElement !== input) this._syncInput(input, field);
    }
    for (const [id, button] of this.presetButtons) {
      button.setAttribute('aria-pressed', String(id === this.settings.preset));
    }
    const description = CAMERA_STUDIO_PRESETS.find(preset => preset.id === this.settings.preset)?.description || '';
    if (this.presetDescription.textContent !== description) this.presetDescription.textContent = description;
    this._renderState();
  }

  setState(state) {
    if (!Object.keys(state).some(key => state[key] !== this.state[key])) return;
    this.state = { ...this.state, ...state };
    this._renderState();
  }

  _renderState() {
    const view = cameraStudioPanelState(this.settings, this.state);
    this.element.hidden = !view.visible;
    this.body.hidden = this.collapsed;
    this.collapseButton.textContent = this.collapsed ? 'Show controls' : 'Hide controls';
    this.collapseButton.setAttribute('aria-expanded', String(!this.collapsed));
    this.toggle.disabled = this.state.busy;
    this.enable.disabled = this.state.busy;
    this.resetButton.disabled = view.disabled;
    if (this.recenterButton) this.recenterButton.disabled = view.disabled;
    for (const button of this.presetButtons.values()) button.disabled = view.disabled;
    for (const { input, field } of this.inputs.values()) input.disabled = field.position ? view.positionDisabled : view.disabled;
    const status = this.state.status || (this.state.busy
      ? 'Camera controls are held while your render finishes.'
      : this.state.positionEnabled
        ? 'Changes apply live and are saved for your next performance.'
        : 'Framing only for this landscape. Spatial moves need full terrain coverage.');
    if (this.status.textContent !== status) this.status.textContent = status;
  }

  dispose() {
    this.element.remove();
    this.setting.remove();
  }
}
