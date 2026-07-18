import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  EyeOff,
  Fingerprint,
  Globe,
  Headphones,
  History,
  Lock,
  Mail,
  MapPin,
  Mic,
  Palette,
  Phone,
  Pipette,
  Plus,
  Radio,
  RotateCcw,
  Server,
  Shield,
  Siren,
  Tag,
  Trash2,
  Video,
  Volume2,
  Wifi,
  X,
} from 'lucide-react';
import { useStreamStore } from '../../stores/streamStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { voksa } from '../../lib/bridge';
import { SettingsBackLink } from './SettingsBackLink';
import { Toggle } from '../ui/Toggle';
import { askConfirm } from '../ui/ConfirmDialog';
import { useT } from '../../lib/i18n';
import type { StreamModeConfig } from '../../../shared/streamConfig';
import {
  DEFAULT_STREAM_COLOR,
  STREAM_COLOR_PRESETS,
  deriveStreamPalette,
  normalizeStreamColor,
} from '../../../shared/streamColor';

type MaskCard = {
  key: keyof StreamModeConfig;
  label: string;
  description: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  demo: string;
  accent?: 'warn' | 'default';
};

const CONTENT_MASKS: MaskCard[] = [
  {
    key: 'maskIPv4',
    label: 'IPv4 publiques',
    description: 'Adresses IPv4 non locales dans le DOM.',
    icon: Globe,
    demo: '1.2.3.4  →  xxx.xxx.xxx.xxx',
  },
  {
    key: 'maskIPv6',
    label: 'IPv6 publiques',
    description: 'Adresses IPv6 non locales dans le DOM.',
    icon: Wifi,
    demo: '2a01:: → xxxx:xxxx:…',
  },
  {
    key: 'maskEmails',
    label: 'Adresses email',
    description: 'Toute adresse email visible sur la page.',
    icon: Mail,
    demo: 'me@foo.com → xxx@xxx.xxx',
  },
  {
    key: 'maskPhones',
    label: 'Numéros de téléphone',
    description: 'Formats internationaux et nationaux courants.',
    icon: Phone,
    demo: '+33 6 12 34 56 78  →  xxx xxx xxx xxx',
  },
  {
    key: 'maskInternalHostnames',
    label: 'Hostnames internes',
    description: '*.local, *.lan et le nom de machine. Désactivé par défaut.',
    icon: Server,
    demo: 'mon-pc.local → xxxxxx.local',
    accent: 'warn',
  },
];

const ACCESS_MASKS: MaskCard[] = [
  {
    key: 'blockWebRTC',
    label: 'Bloquer WebRTC',
    description: 'Empêche toute divulgation d’IP via WebRTC.',
    icon: Radio,
    demo: 'RTCPeerConnection → blocked',
  },
  {
    key: 'denyGeolocation',
    label: 'Refuser la géolocalisation',
    description: 'Demandes refusées sans popup visible.',
    icon: MapPin,
    demo: 'navigator.geolocation → denied',
  },
  {
    key: 'denyCamera',
    label: 'Refuser la caméra',
    description: 'Auto-refus de tout accès caméra.',
    icon: Camera,
    demo: 'getUserMedia(video) → denied',
  },
  {
    key: 'denyMicrophone',
    label: 'Refuser le microphone',
    description: 'Auto-refus de tout accès micro.',
    icon: Mic,
    demo: 'getUserMedia(audio) → denied',
  },
  {
    key: 'hideLinkPreview',
    label: 'Masquer l’aperçu d’URL',
    description: 'Remplace le preview natif au survol des liens.',
    icon: EyeOff,
    demo: 'hover → href masqué',
  },
  {
    key: 'hideHistory',
    label: 'Masquer l’historique',
    description:
      'Suggestions d’adresse et « sites les plus visités » sans votre historique. L’enregistrement continue.',
    icon: History,
    demo: 'suggestions → historique exclu',
  },
  {
    key: 'autoStreamOnRecorder',
    label: 'Détection d’enregistreur',
    description:
      'OBS, Streamlabs, XSplit, vMix… ouvert ou lancé → le Mode Stream s’active tout seul.',
    icon: Video,
    demo: 'OBS détecté → Stream ON',
  },
];

export function StreamPage(): React.ReactElement {
  const t = useT();
  const config = useStreamStore((s) => s.config);
  const update = useStreamStore((s) => s.update);
  const toggle = useStreamStore((s) => s.toggle);

  const maskCount = useMemo(() => {
    let n = 0;
    if (config.maskIPv4) n++;
    if (config.maskIPv6) n++;
    if (config.maskEmails) n++;
    if (config.maskPhones) n++;
    if (config.maskInternalHostnames) n++;
    if (config.blockWebRTC) n++;
    if (config.denyGeolocation) n++;
    if (config.denyCamera) n++;
    if (config.denyMicrophone) n++;
    if (config.hideLinkPreview) n++;
    if (config.hideHistory) n++;
    if (config.autoStreamOnRecorder) n++;
    return n;
  }, [config]);

  const toggleKey = (key: keyof StreamModeConfig, value: boolean) => {
    void update({ [key]: value } as Partial<StreamModeConfig>);
  };

  return (
    <div className="bg-bg text-fg">
      <div className="max-w-4xl mx-auto px-6 py-10">
        <SettingsBackLink />
        <HeroHeader
          enabled={config.enabled}
          maskCount={maskCount}
          customCount={config.customMasks.length}
          onToggle={() => void toggle()}
        />

        <SectionTitle icon={Eye} title={t('Masquage dans le DOM')} subtitle={t('Ce qui est réécrit à la volée sur chaque page visitée.')} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-10">
          {CONTENT_MASKS.map((card) => (
            <MaskToggleCard
              key={card.key as string}
              card={card}
              value={config[card.key] as boolean}
              onChange={(v) => toggleKey(card.key, v)}
            />
          ))}
        </div>

        <SectionTitle icon={Lock} title={t('Permissions & accès matériel')} subtitle={t('Ce qui est refusé automatiquement sans demander.')} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-10">
          {ACCESS_MASKS.map((card) => (
            <MaskToggleCard
              key={card.key as string}
              card={card}
              value={config[card.key] as boolean}
              onChange={(v) => toggleKey(card.key, v)}
            />
          ))}
        </div>

        <SectionTitle
          icon={Palette}
          title={t('Apparence')}
          subtitle={t('La couleur qui signale le Mode Stream dans l’interface.')}
        />
        <StreamColorCard
          color={config.color}
          onChange={(hex) => void update({ color: hex })}
        />

        <SectionTitle
          icon={Tag}
          title={t('Mots-clés personnalisés')}
          subtitle={t('Masquez un nom de projet, un pseudo, une URL interne, n’importe quelle chaîne sensible.')}
        />
        <CustomMasksCard
          masks={config.customMasks}
          concealed={config.enabled}
          onChange={(list) => void update({ customMasks: list })}
        />

        <SectionTitle
          icon={ClipboardCheck}
          title={t('Vérification avant live')}
          subtitle={t('Un audit en un clic de ce qu’un spectateur pourrait apercevoir dans Voksa avant de lancer le direct.')}
        />
        <PreflightCard />

        <SectionTitle
          icon={Siren}
          title={t('Bouton panique')}
          subtitle={t('Un raccourci SYSTÈME qui masque toutes les fenêtres et coupe tout le son, même quand OBS ou le jeu a le focus.')}
        />
        <PanicCard />

        <SectionTitle
          icon={Headphones}
          title={t('Audio par onglet')}
          subtitle={t('Sous Mode Stream, un onglet d’arrière-plan qui se met à jouer du son est coupé automatiquement ; la puce sur l’onglet le réautorise.')}
        />
        <AudioRoutingCard />

        <SectionTitle
          icon={Volume2}
          title={t('Signaux sonores')}
          subtitle={t('Des repères audio courts : vous ENTENDEZ l’état changer sans quitter OBS des yeux. OBS capte ces sons, comme les bips de Discord.')}
        />
        <SoundCuesCard />
      </div>
    </div>
  );
}

// --- Sub-components --------------------------------------------------------

function HeroHeader({
  enabled,
  maskCount,
  customCount,
  onToggle,
}: {
  enabled: boolean;
  maskCount: number;
  customCount: number;
  onToggle: () => void;
}): React.ReactElement {
  const t = useT();
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border mb-10 transition-colors ${
        enabled ? 'border-stream/40 bg-stream/5' : 'border-border bg-bg-elevated'
      }`}
    >
      {/* Subtle gradient flourish in the top-right corner */}
      <div
        className={`absolute -top-20 -right-20 w-64 h-64 rounded-full blur-3xl opacity-30 transition-opacity ${
          enabled ? 'bg-stream' : 'bg-accent'
        }`}
      />
      <div className="relative flex items-center gap-5 p-6">
        <div
          className={`flex-shrink-0 flex items-center justify-center w-14 h-14 rounded-2xl transition-colors ${
            enabled ? 'bg-stream text-stream-fg' : 'bg-accent/15 text-accent'
          }`}
        >
          <Shield size={26} strokeWidth={2.2} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-[22px] font-semibold text-fg">{t('Mode Stream')}</h1>
            <span
              className={`inline-flex items-center gap-1 px-2 h-5 rounded-full text-[11px] font-medium ${
                enabled ? 'bg-stream text-stream-fg' : 'bg-bg-hover text-fg-muted'
              }`}
            >
              {enabled ? <Check size={11} /> : null}
              {enabled ? t('Actif') : t('Inactif')}
            </span>
          </div>
          <p className="text-[13px] text-fg-muted leading-relaxed max-w-xl">
            {t('Masquez en temps réel toutes les données sensibles de vos pages web (IP, emails, permissions, mots-clés personnalisés) pour un partage d’écran ou un live sans fuite.')}
          </p>
          <div className="flex items-center gap-4 mt-3 text-[12px] text-fg-muted">
            <span className="inline-flex items-center gap-1.5">
              <Fingerprint size={12} />{' '}
              {maskCount > 1
                ? t('{n} catégories actives', { n: maskCount })
                : t('{n} catégorie active', { n: maskCount })}
            </span>
            {customCount > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <Tag size={12} />{' '}
                {customCount > 1
                  ? t('{n} mots personnalisés', { n: customCount })
                  : t('{n} mot personnalisé', { n: customCount })}
              </span>
            )}
          </div>
        </div>

        <button
          onClick={onToggle}
          className={`flex-shrink-0 px-5 h-11 rounded-xl font-semibold text-[13px] transition-all shadow-light ${
            enabled
              ? 'bg-stream hover:bg-stream-active text-stream-fg'
              : 'bg-accent hover:bg-accent-hover text-white'
          }`}
        >
          {enabled ? t('Désactiver') : t('Activer')}
        </button>
      </div>
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  title: string;
  subtitle: string;
}): React.ReactElement {
  return (
    <div className="mb-4">
      <h2 className="flex items-center gap-2 text-[14px] font-semibold text-fg mb-1">
        <Icon size={16} className="text-fg-muted" />
        {title}
      </h2>
      <p className="text-[12px] text-fg-muted leading-relaxed">{subtitle}</p>
    </div>
  );
}

function MaskToggleCard({
  card,
  value,
  onChange,
}: {
  card: MaskCard;
  value: boolean;
  onChange: (v: boolean) => void;
}): React.ReactElement {
  const t = useT();
  const Icon = card.icon;
  return (
    <div
      className={`group relative bg-bg-elevated border rounded-xl p-4 transition-all hover:shadow-light ${
        value ? 'border-accent/40' : 'border-border'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
            value
              ? card.accent === 'warn'
                ? 'bg-stream/10 text-stream'
                : 'bg-accent/10 text-accent'
              : 'bg-bg-hover text-fg-muted'
          }`}
        >
          <Icon size={17} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="text-[13px] font-medium text-fg">{t(card.label)}</div>
            <Toggle checked={value} onChange={onChange} />
          </div>
          <p className="text-[11px] text-fg-muted mt-0.5 leading-snug">{t(card.description)}</p>
          <div
            className={`inline-block mt-2 px-2 py-0.5 rounded bg-bg text-[10px] font-mono text-fg-muted border border-border ${
              value ? 'opacity-100' : 'opacity-50'
            }`}
          >
            {t(card.demo)}
          </div>
        </div>
      </div>
    </div>
  );
}

function StreamColorCard({
  color,
  onChange,
}: {
  color: string;
  onChange: (hex: string) => void;
}): React.ReactElement {
  const t = useT();
  const applied = normalizeStreamColor(color) ?? DEFAULT_STREAM_COLOR;
  // Local echo: the native picker fires continuously while dragging, and even
  // a swatch click only lands in the store after an IPC round-trip. The card
  // follows `draft` instantly and drops it once the store caught up.
  const [draft, setDraft] = useState<string | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The hex a debounce timer still owes to the store, plus a live onChange
  // ref so the unmount flush below never calls a stale closure.
  const pendingHex = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (draft !== null && draft === applied) setDraft(null);
  }, [draft, applied]);
  // Unmount with a commit still pending (tab switch or navigation inside the
  // debounce window): flush it instead of dropping it, or the color the user
  // last saw live would silently revert. Safe mid-unmount: onChange writes to
  // the zustand store and IPC, never to this component's state.
  useEffect(
    () => () => {
      if (commitTimer.current) {
        clearTimeout(commitTimer.current);
        commitTimer.current = null;
      }
      if (pendingHex.current !== null) {
        onChangeRef.current(pendingHex.current);
        pendingHex.current = null;
      }
    },
    [],
  );
  const shown = draft ?? applied;

  // Swatch clicks are authoritative: always send, even when the target equals
  // the store echo. `applied` lags behind in-flight commits (async IPC round
  // trip), so a quick "revert" click during that window would otherwise be
  // silently dropped. main's update is idempotent and cosmetic-only changes
  // are already kept out of the masking pipeline (sameMaskingConfig).
  const pick = (hex: string) => {
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    pendingHex.current = null;
    setDraft(hex);
    onChange(hex);
  };
  // Native picker path: trailing debounce, so the settings file and the
  // chrome UI only see the last value of a drag, not every mouse move.
  const pickFromPicker = (hex: string) => {
    setDraft(hex);
    pendingHex.current = hex;
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null;
      pendingHex.current = null;
      onChange(hex);
    }, 200);
  };

  // Same contrast rule as the real surfaces: check mark and pipette stay
  // readable on any swatch color.
  const fgOf = (hex: string): string =>
    `rgb(${deriveStreamPalette(hex)?.light.fg ?? '255 255 255'})`;
  const isCustom = !STREAM_COLOR_PRESETS.includes(shown);

  return (
    <div className="bg-bg-elevated border border-border rounded-xl p-4 mb-10">
      <div className="flex flex-wrap items-center gap-2.5">
        {/* Swatch backgrounds are data (the color being chosen), not theme
            styling: inline style is the point here, not a token bypass. */}
        {STREAM_COLOR_PRESETS.map((hex) => {
          const selected = shown === hex;
          return (
            <button
              key={hex}
              type="button"
              onClick={() => pick(hex)}
              title={hex}
              aria-label={t('Choisir cette couleur ({hex})', { hex })}
              aria-pressed={selected}
              className={`flex items-center justify-center w-8 h-8 rounded-full transition-transform hover:scale-110 ${
                selected ? 'ring-2 ring-border-strong ring-offset-2 ring-offset-bg-elevated' : ''
              }`}
              style={{ background: hex }}
            >
              {selected && <Check size={13} strokeWidth={3} style={{ color: fgOf(hex) }} />}
            </button>
          );
        })}

        <div className="w-px h-6 bg-border mx-0.5" />

        <label
          title={t('Couleur personnalisée')}
          className={`relative flex items-center justify-center w-8 h-8 rounded-full cursor-pointer transition-transform hover:scale-110 ${
            isCustom ? 'ring-2 ring-border-strong ring-offset-2 ring-offset-bg-elevated' : ''
          }`}
          style={{ background: shown }}
        >
          <input
            type="color"
            value={shown}
            onChange={(e) => pickFromPicker(e.target.value)}
            aria-label={t('Couleur personnalisée')}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
          <Pipette size={13} style={{ color: fgOf(shown) }} />
        </label>
        <span className="font-mono text-[11px] text-fg-muted uppercase">{shown}</span>

        <div className="flex-1" />

        {shown !== DEFAULT_STREAM_COLOR && (
          <button
            type="button"
            onClick={() => pick(DEFAULT_STREAM_COLOR)}
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[12px] text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
          >
            <RotateCcw size={12} />
            {t('Réinitialiser')}
          </button>
        )}
      </div>
      <p className="mt-3 text-[11px] text-fg-muted leading-snug">
        {t('Appliquée en direct au liseré de fenêtre, au bouclier de la barre d’outils et à tous les indicateurs du Mode Stream, en thème clair comme en thème sombre.')}
      </p>
    </div>
  );
}

function CustomMasksCard({
  masks,
  concealed,
  onChange,
}: {
  masks: string[];
  /**
   * Stream Mode is live: the keywords ARE the secrets, so this very page
   * must not display them. Chips render as bullets and the add-input is
   * visually redacted (the typed value itself stays intact).
   */
  concealed: boolean;
  onChange: (list: string[]) => void;
}): React.ReactElement {
  const t = useT();
  const [input, setInput] = useState('');

  const add = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (masks.some((m) => m.toLowerCase() === trimmed.toLowerCase())) {
      setInput('');
      return;
    }
    onChange([...masks, trimmed]);
    setInput('');
  };

  const remove = (index: number) => {
    const next = masks.slice();
    next.splice(index, 1);
    onChange(next);
  };

  const clear = async () => {
    if (masks.length === 0) return;
    const ok = await askConfirm({
      title:
        masks.length > 1
          ? t('Supprimer {n} mots-clés ?', { n: masks.length })
          : t('Supprimer {n} mot-clé ?', { n: masks.length }),
      confirmLabel: t('Supprimer'),
      danger: true,
    });
    if (ok) onChange([]);
  };

  return (
    <div className="bg-bg-elevated border border-border rounded-xl overflow-hidden mb-10">
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Tag
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none"
            />
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder={t('Ajouter un mot ou une phrase à masquer…')}
              className={`w-full h-10 pl-9 pr-3 rounded-lg bg-bg border border-border focus:border-accent focus:outline-none focus:shadow-[0_0_0_3px_rgba(59,125,255,0.12)] text-[13px] transition-all ${
                concealed ? '[-webkit-text-security:disc]' : ''
              }`}
            />
          </div>
          <button
            type="button"
            onClick={add}
            disabled={!input.trim()}
            className="flex-shrink-0 inline-flex items-center gap-1.5 px-4 h-10 rounded-lg bg-accent hover:bg-accent-hover text-white text-[13px] font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Plus size={15} />
            {t('Ajouter')}
          </button>
        </div>
        <p className="mt-3 text-[11px] text-fg-muted leading-snug">
          {t('La recherche est insensible à la casse. Chaque correspondance est remplacée par des puces. Parfait pour masquer un nom de client, un identifiant interne ou un secret que vous ne voulez pas qu’on voie dans votre flux.')}
        </p>
      </div>

      {masks.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-fg-subtle">
          {t('Aucun mot-clé personnalisé pour le moment.')}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 p-4">
            {masks.map((m, i) => (
              <MaskChip
                key={`${m}-${i}`}
                text={m}
                concealed={concealed}
                onRemove={() => remove(i)}
              />
            ))}
          </div>
          <div className="flex justify-end items-center gap-2 px-4 py-2 border-t border-border bg-bg/50">
            <span className="text-[11px] text-fg-muted flex-1">
              {masks.length > 1
                ? t('{n} mots actifs', { n: masks.length })
                : t('{n} mot actif', { n: masks.length })}
            </span>
            <button
              type="button"
              onClick={() => void clear()}
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[12px] text-fg-muted hover:text-stream hover:bg-stream/10 transition-colors"
            >
              <Trash2 size={12} />
              {t('Tout effacer')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function MaskChip({
  text,
  concealed,
  onRemove,
}: {
  text: string;
  concealed: boolean;
  onRemove: () => void;
}): React.ReactElement {
  const t = useT();
  // Bullets rendered directly (not via maskText): maskText ignores masks
  // shorter than 2 chars, and here we KNOW the whole string is the secret.
  const display = concealed ? '•'.repeat(Math.max(3, text.length)) : text;
  return (
    <div className="group inline-flex items-center gap-1.5 pl-3 pr-1 h-8 rounded-full bg-bg border border-border hover:border-stream/40 hover:bg-stream/5 transition-colors">
      <span className="text-[12px] font-mono text-fg max-w-[220px] truncate">{display}</span>
      <button
        type="button"
        onClick={onRemove}
        className="flex items-center justify-center w-6 h-6 rounded-full text-fg-muted hover:text-stream hover:bg-stream/15 transition-colors"
        aria-label={concealed ? t('Retirer le mot-clé masqué') : t('Retirer {text}', { text })}
      >
        <X size={11} />
      </button>
    </div>
  );
}

/**
 * Panic Key card: enable + rebind. The capture field records the NEXT chord
 * pressed while focused (the standard rebind pattern): modifiers + one real
 * key, refused otherwise. The hotkey itself is registered lazily by main
 * (only while Stream Mode is armed), which the description says out loud.
 */
function PanicCard(): React.ReactElement {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const [capturing, setCapturing] = useState(false);

  const onCaptureKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setCapturing(false);
      return;
    }
    // Pure-modifier presses are a chord in progress, not a chord.
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const mods: string[] = [];
    if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (mods.length === 0) return; // a bare letter cannot be a GLOBAL shortcut
    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    void update({ panicKey: [...mods, key].join('+') });
    setCapturing(false);
  };

  return (
    <div className="bg-bg-elevated border border-border rounded-xl p-4 mb-10">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fg">{t('Bouton panique')}</div>
          <div className="mt-0.5 text-[12px] text-fg-muted">
            {t('Rideau sur toutes les fenêtres + son coupé + Mode Stream armé. Second appui : tout revient (le Mode Stream reste armé).')}
          </div>
          <div className="mt-0.5 text-[12px] text-fg-subtle">
            {t('Le raccourci n’est actif que pendant que le Mode Stream est armé.')}
          </div>
        </div>
        <button
          type="button"
          data-voksa-panic-rebind
          onClick={() => setCapturing(true)}
          onKeyDown={onCaptureKey}
          onBlur={() => setCapturing(false)}
          disabled={!settings.panicKeyEnabled}
          className={`flex-shrink-0 px-3 h-9 rounded-lg border text-sm font-mono transition-colors ${
            capturing
              ? 'border-stream text-stream bg-stream-muted'
              : 'border-border text-fg hover:bg-bg-hover'
          } disabled:opacity-50`}
          title={t('Cliquer puis appuyer sur le nouveau raccourci')}
        >
          {capturing ? t('Appuyez sur un raccourci…') : settings.panicKey}
        </button>
        <Toggle
          checked={settings.panicKeyEnabled}
          onChange={(v) => void update({ panicKeyEnabled: v })}
        />
      </div>
    </div>
  );
}

/**
 * DMCA stage 2 explainer. The routing itself lives in the tab context menu
 * (it is a per-tab gesture); this card makes it discoverable and states the
 * honest scope: risk reduction, never "DMCA immunity".
 */
function AudioRoutingCard(): React.ReactElement {
  const t = useT();
  return (
    <div className="rounded-2xl border border-border bg-bg-elevated p-5 mb-10">
      <p className="text-[13px] text-fg leading-relaxed">
        {t('Envoyez le son d’un onglet vers une autre sortie : clic droit sur l’onglet, « Sortie audio », choisissez votre casque. OBS, qui capte la sortie par défaut, n’entend plus cet onglet ; vous, si.')}
      </p>
      <p className="text-[12px] text-fg-muted leading-relaxed mt-2">
        {t('Réduction de risque, pas une immunité : un lecteur intégré venant d’un autre site (iframe), une frame sans préchargement ou un flux DRM peut échapper au routage et rester sur la sortie système. Si le périphérique choisi disparaît, l’onglet revient sur la sortie système et le menu cesse de l’afficher : rien n’est prétendu couvert qui ne l’est pas.')}
      </p>
    </div>
  );
}

/** Audio cue toggles. The cues are WebAudio beeps generated in the chrome UI
 * (see SoundSignals in Chrome.tsx): no assets, nothing to load. */
function SoundCuesCard(): React.ReactElement {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const cues = settings.soundCues;

  const row = (label: string, description: string, key: keyof typeof cues) => (
    <div className="flex items-center gap-4 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-fg">{label}</div>
        <div className="text-[12px] text-fg-subtle">{description}</div>
      </div>
      <Toggle
        checked={cues[key]}
        onChange={(v) => void update({ soundCues: { ...cues, [key]: v } })}
      />
    </div>
  );

  return (
    <div className="bg-bg-elevated border border-border rounded-xl px-4 py-1.5 divide-y divide-border">
      {row(
        t('Mode Stream armé / désarmé'),
        t('Deux notes montantes à l’armement, descendantes au retrait.'),
        'streamToggle',
      )}
      {row(t('Téléchargement terminé'), t('Un bip discret quand un fichier arrive.'), 'downloadDone')}
      {row(t('Mise à jour prête'), t('Un bip quand une nouvelle version attend le redémarrage.'), 'updateReady')}
    </div>
  );
}

type PreflightFinding =
  | { kind: 'sensitive-text'; tabId: string; label: string; where: 'title' | 'url' | 'both' }
  | { kind: 'audible'; tabId: string; label: string };

/**
 * Go-Live Preflight card: one click audits every Voksa tab for what a viewer
 * could catch (an email/IP/keyword in a title or URL, a background tab making
 * sound), each with a one-click fix. The scan runs in main against the same
 * mask config the page masker uses, so a finding is exactly what Stream Mode
 * would mask. Honest scope: it audits VOKSA, not Discord or the desktop.
 */
function PreflightCard(): React.ReactElement {
  const t = useT();
  const [findings, setFindings] = useState<PreflightFinding[] | null>(null);
  const [scanned, setScanned] = useState(0);
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    void voksa.preflight
      .run()
      .then((report) => {
        setFindings(report.findings);
        setScanned(report.scanned);
      })
      .finally(() => setBusy(false));
  };

  const resolve = (finding: PreflightFinding) => {
    if (finding.kind === 'audible') void voksa.tabs.mute(finding.tabId, true);
    else void voksa.tabs.close(finding.tabId);
    // Drop it from the list optimistically; a re-scan confirms.
    setFindings((prev) => (prev ? prev.filter((f) => f !== finding) : prev));
  };

  return (
    <div className="bg-bg-elevated border border-border rounded-xl p-4 mb-10">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0 text-[12px] text-fg-subtle">
          {t('L’audit couvre les onglets de Voksa. Il ne voit pas Discord, les notifications système ni le reste de l’écran.')}
        </div>
        <button
          type="button"
          data-voksa-preflight-run
          onClick={run}
          disabled={busy}
          className="flex-shrink-0 px-3 h-9 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
        >
          {busy ? t('Analyse…') : t('Lancer la vérification')}
        </button>
      </div>

      {findings !== null && (
        <div className="mt-4" data-voksa-preflight-result={findings.length}>
          {findings.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-accent">
              <CheckCircle2 size={16} />
              {t('Rien à signaler sur {n} onglets.', { n: scanned })}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {findings.map((f, i) => (
                <li
                  key={`${f.tabId}-${i}`}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-inset"
                >
                  <span className="flex-1 min-w-0 text-[13px] text-fg truncate">
                    {f.kind === 'audible'
                      ? t('Son en arrière-plan : {label}', { label: f.label })
                      : t('Donnée sensible : {label}', { label: f.label })}
                  </span>
                  <button
                    type="button"
                    onClick={() => resolve(f)}
                    className="flex-shrink-0 px-2.5 h-8 rounded-lg text-[12px] font-medium text-white bg-stream hover:opacity-90"
                  >
                    {f.kind === 'audible' ? t('Couper le son') : t('Fermer l’onglet')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
