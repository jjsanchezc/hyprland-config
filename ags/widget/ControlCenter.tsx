import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createBinding, createState, For, With } from "ags"
import { createPoll } from "ags/time"
import { execAsync } from "ags/process"
import AstalWp from "gi://AstalWp"
import AstalNetwork from "gi://AstalNetwork"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalBattery from "gi://AstalBattery"
import AstalMpris from "gi://AstalMpris"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"

// === Services ===
const wp = AstalWp.get_default()!
const speaker = wp.audio.default_speaker!
const mic = wp.audio.default_microphone!
const network = AstalNetwork.get_default()
const bt = AstalBluetooth.get_default()
const battery = AstalBattery.get_default()
const mpris = AstalMpris.get_default()
const notifd = AstalNotifd.get_default()

// === Brightness (via brightnessctl) ===
const decoder = new TextDecoder()
const getBrightness = () => {
    try {
        const max = Number(decoder.decode(GLib.spawn_command_line_sync("brightnessctl max")[1] as any))
        const cur = Number(decoder.decode(GLib.spawn_command_line_sync("brightnessctl get")[1] as any))
        return max > 0 ? cur / max : 1
    } catch { return 1 }
}
const [brightnessVal, setBrightnessVal] = createState(getBrightness())

// === Uptime ===
const uptime = createPoll("", 60_000, () => {
    try {
        const contents = GLib.file_get_contents("/proc/uptime")
        if (contents[0]) {
            const text = decoder.decode(contents[1] as any)
            const secs = Number(text.split(".")[0])
            const h = Math.floor(secs / 3600)
            const m = Math.floor((secs % 3600) / 60)
            return `${h}h ${m < 10 ? "0" + m : m}m`
        }
    } catch {}
    return "0h 00m"
})

// === Power Profile (via asusctl) ===
const [profileExpanded, setProfileExpanded] = createState(false)

const getActiveProfile = () => {
    try {
        const out = decoder.decode(GLib.spawn_command_line_sync(
            "bash -c \"asusctl profile get 2>/dev/null | sed 's/Active profile: //' | tr '[:upper:]' '[:lower:]'\""
        )[1] as any).trim()
        return out || "balanced"
    } catch { return "balanced" }
}

const [currentProfileState, setCurrentProfile] = createState(getActiveProfile())
const currentProfile = currentProfileState

// === Expandable toggle state ===
const [wifiExpanded, setWifiExpanded] = createState(false)
const [btExpanded, setBtExpanded] = createState(false)
const [powerExpanded, setPowerExpanded] = createState(false)
const [powerConfirm, setPowerConfirm] = createState("")

// === Idle Timeouts ===
const HYPRIDLE_CONF  = "/home/jjsanchezc/dotfiles-hypr/hyprland/hypridle.conf"
const PROFILES_FILE  = "/home/jjsanchezc/.config/ags/hypridle-profiles.json"

type IdleProfile = { lock: number; screenOff: number; suspend: number }
type ProfileKey  = "battery" | "charging"

const DEFAULT_PROFILES: Record<ProfileKey, IdleProfile> = {
    battery:  { lock: 120,  screenOff: 300,  suspend: 900 },
    charging: { lock: 600,  screenOff: 900,  suspend: 0   },
}

const parseIdleTimeouts = (): IdleProfile => {
    try {
        const contents = GLib.file_get_contents(HYPRIDLE_CONF)
        if (contents[0]) {
            const text = decoder.decode(contents[1] as any)
            const lockMatch      = text.match(/timeout\s*=\s*(\d+)[^}]*?on-timeout\s*=\s*loginctl lock-session/s)
            const screenOffMatch = text.match(/timeout\s*=\s*(\d+)[^}]*?on-timeout\s*=\s*hyprctl dispatch dpms off/s)
            const suspendMatch   = text.match(/timeout\s*=\s*(\d+)[^}]*?on-timeout\s*=\s*systemctl suspend/s)
            return {
                lock:      lockMatch      ? Number(lockMatch[1])      : 300,
                screenOff: screenOffMatch ? Number(screenOffMatch[1]) : 0,
                suspend:   suspendMatch   ? Number(suspendMatch[1])   : 0,
            }
        }
    } catch {}
    return { lock: 300, screenOff: 600, suspend: 1800 }
}

const loadProfiles = (): Record<ProfileKey, IdleProfile> => {
    try {
        const result = GLib.file_get_contents(PROFILES_FILE)
        if (result[0]) {
            const parsed = JSON.parse(decoder.decode(result[1] as any))
            return {
                battery:  { ...DEFAULT_PROFILES.battery,  ...parsed.battery  },
                charging: { ...DEFAULT_PROFILES.charging, ...parsed.charging },
            }
        }
    } catch {}
    // First run: seed both profiles from the current hypridle.conf
    const current = parseIdleTimeouts()
    return { battery: current, charging: current }
}

const saveProfiles = (bat: IdleProfile, chg: IdleProfile) => {
    GLib.file_set_contents(PROFILES_FILE, JSON.stringify({ battery: bat, charging: chg }, null, 2))
}

const buildHypridleConf = (lock: number, screenOff: number, suspend: number): string => {
    const lockBlock = lock > 0 ? `
listener {
    timeout = ${lock}
    on-timeout = loginctl lock-session
}` : ""
    const screenBlock = screenOff > 0 ? `
listener {
    timeout = ${screenOff}
    on-timeout = hyprctl dispatch dpms off
    on-resume = hyprctl dispatch dpms on
}` : ""
    const suspendBlock = suspend > 0 ? `
listener {
    timeout = ${suspend}
    on-timeout = systemctl suspend
}` : ""
    return `general {
    lock_cmd = pidof hyprlock || hyprlock
    before_sleep_cmd = loginctl lock-session
    after_sleep_cmd = pkill waybar; sleep 1; waybar &
}
${lockBlock}
${screenBlock}
${suspendBlock}
`
}

const isOnAC = (state: any) =>
    state === (AstalBattery as any).State?.CHARGING ||
    state === (AstalBattery as any).State?.FULLY_CHARGED ||
    Number(state) === 1 || Number(state) === 4

const applyIdleTimeouts = async (profile: IdleProfile) => {
    const conf = buildHypridleConf(profile.lock, profile.screenOff, profile.suspend)
    GLib.file_set_contents(HYPRIDLE_CONF, conf)
    await execAsync(["bash", "-c", "killall hypridle 2>/dev/null; sleep 0.3; hypridle &"])
}

const initProfiles = loadProfiles()
const [batteryProfile,  setBatteryProfile]  = createState<IdleProfile>(initProfiles.battery)
const [chargingProfile, setChargingProfile] = createState<IdleProfile>(initProfiles.charging)
const [editingProfile,  setEditingProfile]  = createState<ProfileKey>(
    isOnAC(battery.state) ? "charging" : "battery"
)
const [idleExpanded, setIdleExpanded] = createState(false)

// Apply correct profile on startup
applyIdleTimeouts(isOnAC(battery.state) ? chargingProfile() : batteryProfile())

// Auto-switch on plug/unplug
battery.connect("notify::state", () => {
    const onAC = isOnAC(battery.state)
    applyIdleTimeouts(onAC ? chargingProfile() : batteryProfile())
    setEditingProfile(onAC ? "charging" : "battery")
})

function resetWindowSize() {
    const win = app.get_window("control-center")
    if (win) win.set_default_size(1, 1)
}

// ============================================================
//  HEADER
// ============================================================
function Header() {
    return (
        <box class="header" spacing={10}>
            <box valign={Gtk.Align.CENTER} hexpand spacing={12}>
                <box spacing={6} visible={createBinding(battery, "isPresent")}>
                    <image iconName={createBinding(battery, "iconName")} />
                    <label label={createBinding(battery, "percentage")((p) => `${Math.floor(p * 100)}%`)} />
                </box>
                <label class="header-sep" label="|"
                    visible={createBinding(battery, "isPresent")} />
                <box spacing={6}>
                    <image iconName="preferences-system-time-symbolic" />
                    <label label={uptime} />
                </box>
            </box>
            <button class="sys-button" valign={Gtk.Align.CENTER}
                onClicked={() => {
                    setIdleExpanded(!idleExpanded())
                    setPowerExpanded(false)
                    setPowerConfirm("")
                }}>
                <image iconName="alarm-symbolic" />
            </button>
            <button class="sys-button" valign={Gtk.Align.CENTER}
                onClicked={() => {
                    setPowerExpanded(!powerExpanded())
                    setPowerConfirm("")
                    setIdleExpanded(false)
                }}>
                <image iconName="system-shutdown-symbolic" />
            </button>
        </box>
    )
}

// ============================================================
//  POWER PANEL (expandable)
// ============================================================
const powerActions = [
    { id: "lock", label: "Lock", icon: "system-lock-screen-symbolic", cmd: ["hyprlock"] },
    { id: "suspend", label: "Suspend", icon: "media-playback-pause-symbolic", cmd: ["systemctl", "suspend"] },
    { id: "logout", label: "Logout", icon: "system-log-out-symbolic", cmd: ["pkill", "Hyprland"] },
    { id: "reboot", label: "Reboot", icon: "system-reboot-symbolic", cmd: ["systemctl", "reboot"] },
    { id: "shutdown", label: "Shutdown", icon: "system-shutdown-symbolic", cmd: ["systemctl", "poweroff"] },
    { id: "reload", label: "Reload AGS", icon: "emblem-synchronous-symbolic", cmd: ["bash", "-c", "ags quit; ags run"] },
]

function PowerPanel() {
    return (
        <box class="power-panel" orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            {powerActions.map((action) => (
                <box orientation={Gtk.Orientation.VERTICAL}>
                    <button class="power-item"
                        onClicked={() => {
                            if (powerConfirm() === action.id) {
                                execAsync(action.cmd)
                                setPowerConfirm("")
                                setPowerExpanded(false)
                            } else {
                                setPowerConfirm(action.id)
                            }
                        }}>
                        <box spacing={8}>
                            <image iconName={action.icon} />
                            <label label={action.label} hexpand xalign={0} />
                            <label class="power-hint"
                                label={powerConfirm((c: string) => c === action.id ? "Click to confirm" : "")} />
                        </box>
                    </button>
                    <revealer
                        revealChild={powerConfirm((c: string) => c === action.id)}
                        transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                        transitionDuration={150}>
                        <box class="power-confirm" spacing={8}>
                            <label label={`Confirm ${action.label}?`} hexpand xalign={0} />
                            <button class="confirm-yes"
                                onClicked={() => {
                                    execAsync(action.cmd)
                                    setPowerConfirm("")
                                    setPowerExpanded(false)
                                }}>
                                <label label="Yes" />
                            </button>
                            <button class="confirm-no"
                                onClicked={() => setPowerConfirm("")}>
                                <label label="No" />
                            </button>
                        </box>
                    </revealer>
                </box>
            ))}
        </box>
    )
}

// ============================================================
//  IDLE TIMEOUTS PANEL
// ============================================================
const LOCK_PRESETS = [
    { label: "2m",    secs: 120  },
    { label: "5m",    secs: 300  },
    { label: "10m",   secs: 600  },
    { label: "15m",   secs: 900  },
    { label: "Never", secs: 0    },
]
const SCREEN_OFF_PRESETS = [
    { label: "5m",    secs: 300  },
    { label: "10m",   secs: 600  },
    { label: "15m",   secs: 900  },
    { label: "30m",   secs: 1800 },
    { label: "Never", secs: 0    },
]
const SUSPEND_PRESETS = [
    { label: "15m",   secs: 900  },
    { label: "30m",   secs: 1800 },
    { label: "1h",    secs: 3600 },
    { label: "2h",    secs: 7200 },
    { label: "Never", secs: 0    },
]

const secsLabel = (s: number) => s === 0 ? "Never" : s < 3600 ? `${s / 60}m` : `${s / 3600}h`

function IdleTimeoutsPanel() {
    const lockBtns    = new Map<number, any>()
    const screenBtns  = new Map<number, any>()
    const suspendBtns = new Map<number, any>()
    const tabBtns     = new Map<ProfileKey, any>()

    const refreshBtns = (map: Map<number, any>, active: number) => {
        for (const [secs, btn] of map) {
            if (secs === active) btn.add_css_class("active")
            else btn.remove_css_class("active")
        }
    }

    const activeProfile = () =>
        editingProfile() === "battery" ? batteryProfile() : chargingProfile()

    const updateField = async (field: keyof IdleProfile, value: number) => {
        const updated = { ...activeProfile(), [field]: value }
        if (editingProfile() === "battery") {
            setBatteryProfile(updated)
            saveProfiles(updated, chargingProfile())
            if (!isOnAC(battery.state)) await applyIdleTimeouts(updated)
        } else {
            setChargingProfile(updated)
            saveProfiles(batteryProfile(), updated)
            if (isOnAC(battery.state)) await applyIdleTimeouts(updated)
        }
    }

    const switchTab = (key: ProfileKey) => {
        setEditingProfile(key)
        for (const [k, btn] of tabBtns) {
            if (k === key) btn.add_css_class("active")
            else btn.remove_css_class("active")
        }
        const p = key === "battery" ? batteryProfile() : chargingProfile()
        refreshBtns(lockBtns,    p.lock)
        refreshBtns(screenBtns,  p.screenOff)
        refreshBtns(suspendBtns, p.suspend)
    }

    return (
        <box class="idle-panel" orientation={Gtk.Orientation.VERTICAL} spacing={10}>
            {/* Tab strip */}
            <box class="idle-tab-strip" spacing={0} homogeneous>
                {(["battery", "charging"] as ProfileKey[]).map((key) => (
                    <button class="idle-tab"
                        $={(self) => {
                            tabBtns.set(key, self)
                            if (editingProfile() === key) self.add_css_class("active")
                        }}
                        onClicked={() => switchTab(key)}>
                        <box spacing={6} halign={Gtk.Align.CENTER}>
                            <image iconName={key === "battery" ? "battery-symbolic" : "ac-adapter-symbolic"} />
                            <label label={key === "battery" ? "Battery" : "Charging"} />
                            <box class="live-dot"
                                visible={createBinding(battery, "state")((s: any) =>
                                    (isOnAC(s) ? "charging" : "battery") === key
                                )} />
                        </box>
                    </button>
                ))}
            </box>

            {/* Lock Screen row */}
            <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                <box spacing={6}>
                    <image iconName="system-lock-screen-symbolic" />
                    <label label="Lock Screen" hexpand xalign={0} />
                    <label class="idle-current"
                        label={editingProfile((k: ProfileKey) =>
                            secsLabel(k === "battery" ? batteryProfile().lock : chargingProfile().lock)
                        )} />
                </box>
                <box class="preset-row" spacing={4} homogeneous>
                    {LOCK_PRESETS.map(p => (
                        <button class="preset-btn"
                            $={(self) => {
                                lockBtns.set(p.secs, self)
                                if (activeProfile().lock === p.secs) self.add_css_class("active")
                            }}
                            onClicked={() => {
                                refreshBtns(lockBtns, p.secs)
                                updateField("lock", p.secs)
                            }}>
                            <label label={p.label} />
                        </button>
                    ))}
                </box>
            </box>

            {/* Screen Off row */}
            <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                <box spacing={6}>
                    <image iconName="display-brightness-symbolic" />
                    <label label="Screen Off" hexpand xalign={0} />
                    <label class="idle-current"
                        label={editingProfile((k: ProfileKey) =>
                            secsLabel(k === "battery" ? batteryProfile().screenOff : chargingProfile().screenOff)
                        )} />
                </box>
                <box class="preset-row" spacing={4} homogeneous>
                    {SCREEN_OFF_PRESETS.map(p => (
                        <button class="preset-btn"
                            $={(self) => {
                                screenBtns.set(p.secs, self)
                                if (activeProfile().screenOff === p.secs) self.add_css_class("active")
                            }}
                            onClicked={() => {
                                refreshBtns(screenBtns, p.secs)
                                updateField("screenOff", p.secs)
                            }}>
                            <label label={p.label} />
                        </button>
                    ))}
                </box>
            </box>

            {/* Suspend row */}
            <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                <box spacing={6}>
                    <image iconName="system-suspend-symbolic" />
                    <label label="Suspend" hexpand xalign={0} />
                    <label class="idle-current"
                        label={editingProfile((k: ProfileKey) =>
                            secsLabel(k === "battery" ? batteryProfile().suspend : chargingProfile().suspend)
                        )} />
                </box>
                <box class="preset-row" spacing={4} homogeneous>
                    {SUSPEND_PRESETS.map(p => (
                        <button class="preset-btn"
                            $={(self) => {
                                suspendBtns.set(p.secs, self)
                                if (activeProfile().suspend === p.secs) self.add_css_class("active")
                            }}
                            onClicked={() => {
                                refreshBtns(suspendBtns, p.secs)
                                updateField("suspend", p.secs)
                            }}>
                            <label label={p.label} />
                        </button>
                    ))}
                </box>
            </box>
        </box>
    )
}

// ============================================================
//  VOLUME SLIDER
// ============================================================
function VolumeSlider() {
    return (
        <box class="slider-row" spacing={8}>
            <button valign={Gtk.Align.CENTER}
                onClicked={() => speaker.set_mute(!speaker.mute)}>
                <image iconName={createBinding(speaker, "volumeIcon")} />
            </button>
            <slider
                hexpand
                value={createBinding(speaker, "volume")}
                onChangeValue={({ value }) => speaker.set_volume(value)}
            />
            <label class="slider-value"
                label={createBinding(speaker, "volume")((v) => `${Math.round(v * 100)}%`)}
                widthChars={4} xalign={1} />
        </box>
    )
}

// ============================================================
//  MICROPHONE SLIDER
// ============================================================
function MicSlider() {
    return (
        <box class="slider-row" spacing={8}>
            <button valign={Gtk.Align.CENTER}
                onClicked={() => mic.set_mute(!mic.mute)}>
                <image iconName={createBinding(mic, "volumeIcon")} />
            </button>
            <slider
                hexpand
                value={createBinding(mic, "volume")}
                onChangeValue={({ value }) => mic.set_volume(value)}
            />
            <label class="slider-value"
                label={createBinding(mic, "volume")((v) => `${Math.round(v * 100)}%`)}
                widthChars={4} xalign={1} />
        </box>
    )
}

// ============================================================
//  BRIGHTNESS SLIDER
// ============================================================
function BrightnessSlider() {
    return (
        <box class="slider-row" spacing={8}>
            <button valign={Gtk.Align.CENTER}
                onClicked={() => {
                    execAsync(["brightnessctl", "set", "0%", "-q"])
                    setBrightnessVal(0)
                }}>
                <image iconName="display-brightness-symbolic" />
            </button>
            <slider
                hexpand
                value={brightnessVal()}
                onChangeValue={({ value }) => {
                    execAsync(["brightnessctl", "set", `${Math.round(value * 100)}%`, "-q"])
                    setBrightnessVal(value)
                }}
            />
            <label class="slider-value"
                label={brightnessVal((v: number) => `${Math.round(v * 100)}%`)}
                widthChars={4} xalign={1} />
        </box>
    )
}

// ============================================================
//  WIFI TOGGLE (expandable)
// ============================================================
function WifiToggle() {
    const wifi = network.wifi

    return (
        <box class="toggle-btn"
            $={(self) => {
                const update = () => {
                    if (wifi?.enabled) self.add_css_class("active")
                    else self.remove_css_class("active")
                }
                wifi?.connect("notify::enabled", update)
                update()
            }}>
            <button class="toggle-main" hexpand
                onClicked={() => {
                    if (wifi) {
                        wifi.enabled = !wifi.enabled
                        if (wifi.enabled) wifi.scan()
                    }
                }}>
                <box spacing={8}>
                    <image iconName={wifi ? createBinding(wifi, "iconName") : "network-wireless-offline-symbolic"} />
                    <label label={wifi ? createBinding(wifi, "ssid")((s) => s || "Disconnected") : "No WiFi"}
                        hexpand xalign={0} maxWidthChars={8} ellipsize={3} />
                </box>
            </button>
            <button class="toggle-arrow"
                onClicked={() => {
                    setWifiExpanded(!wifiExpanded())
                    setBtExpanded(false)
                    if (!wifiExpanded() && wifi) wifi.scan()
                }}>
                <image iconName={wifiExpanded((e: boolean) => e ? "pan-down-symbolic" : "pan-end-symbolic")} />
            </button>
        </box>
    )
}

// ============================================================
//  BLUETOOTH TOGGLE (expandable)
// ============================================================
function BluetoothToggle() {
    return (
        <box class="toggle-btn"
            $={(self) => {
                const update = () => {
                    if (bt.is_powered) self.add_css_class("active")
                    else self.remove_css_class("active")
                }
                bt.connect("notify::is-powered", update)
                update()
            }}>
            <button class="toggle-main" hexpand
                onClicked={() => bt.toggle()}>
                <box spacing={8}>
                    <image iconName={createBinding(bt, "isPowered")((on) =>
                        on ? "bluetooth-active-symbolic" : "bluetooth-disabled-symbolic"
                    )} />
                    <label label={createBinding(bt, "isPowered")((on) => {
                        if (!on) return "Off"
                        const connected = bt.get_devices().filter(d => d.connected)
                        if (connected.length === 1) return connected[0].alias
                        if (connected.length > 1) return `${connected.length} Connected`
                        return "On"
                    })} hexpand xalign={0} maxWidthChars={8} ellipsize={3} />
                </box>
            </button>
            <button class="toggle-arrow"
                onClicked={() => {
                    setBtExpanded(!btExpanded())
                    setWifiExpanded(false)
                }}>
                <image iconName={btExpanded((e: boolean) => e ? "pan-down-symbolic" : "pan-end-symbolic")} />
            </button>
        </box>
    )
}

// ============================================================
//  WIFI DETAILS (expandable panel)
// ============================================================
function WifiDetails() {
    const wifi = network.wifi
    if (!wifi) return <box />

    const [showPassword, setShowPassword] = createState(false)
    const [connectingSSID, setConnectingSSID] = createState("")
    let pendingSSID = ""
    let pwEntryRef: Gtk.Entry | null = null

    const connectToAp = async (ssid: string, password?: string) => {
        setConnectingSSID(ssid)
        try {
            if (password) {
                await execAsync(["nmcli", "device", "wifi", "connect", ssid, "password", password])
            } else {
                const saved = (await execAsync(["bash", "-c", "nmcli -g NAME connection"])).trim()
                if (saved.split("\n").includes(ssid)) {
                    await execAsync(["nmcli", "connection", "up", "id", ssid])
                } else {
                    setConnectingSSID("")
                    pendingSSID = ssid
                    setShowPassword(true)
                    if (pwEntryRef) pwEntryRef.set_text("")
                    return
                }
            }
            setShowPassword(false)
            pendingSSID = ""
            if (pwEntryRef) pwEntryRef.set_text("")
            execAsync(["notify-send", "WiFi", `Connected to ${ssid}`])
        } catch (e) {
            execAsync(["notify-send", "-u", "critical", "WiFi", `Failed to connect to ${ssid}`])
        }
        setConnectingSSID("")
    }

    // Deduplicated APs sorted by signal, excluding active network
    const availableAps = createBinding(wifi, "accessPoints")((aps: any[]) => {
        const activeSsid = wifi.activeAccessPoint?.ssid
        const seen = new Map()
        for (const ap of aps) {
            const ssid = ap.ssid
            if (!ssid) continue
            if (ssid === activeSsid) continue
            if (!seen.has(ssid) || seen.get(ssid).strength < ap.strength) {
                seen.set(ssid, ap)
            }
        }
        return [...seen.values()].sort((a: any, b: any) => b.strength - a.strength)
    })

    return (
        <box class="details-panel" orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            {/* Connected network */}
            <box class="detail-item connected" spacing={8}
                visible={createBinding(wifi, "activeAccessPoint")((ap) => ap !== null)}>
                <image iconName={createBinding(wifi, "iconName")} />
                <label label={createBinding(wifi, "ssid")((s) => s || "Connected")}
                    hexpand xalign={0} maxWidthChars={20} ellipsize={3} />
                <label class="ap-strength"
                    label={createBinding(wifi, "strength")((s) => `${s}%`)} />
                <label class="detail-status" label="Connected" />
            </box>

            <box spacing={8}>
                <label class="detail-section-label" label="AVAILABLE" hexpand xalign={0} />
                <button class="scan-btn"
                    onClicked={() => wifi.scan()}>
                    <image iconName="view-refresh-symbolic" />
                </button>
            </box>

            <For each={availableAps}>
                {(ap) => (
                    <button class="detail-item"
                        onClicked={() => {
                            if (ap.ssid) connectToAp(ap.ssid)
                        }}>
                        <box spacing={8}>
                            <image iconName={createBinding(ap, "iconName")} />
                            <label label={createBinding(ap, "ssid")((s) => s || "Hidden")}
                                hexpand xalign={0} maxWidthChars={20} ellipsize={3} />
                            <label class="ap-strength"
                                label={createBinding(ap, "strength")((s) => `${s}%`)} />
                        </box>
                    </button>
                )}
            </For>

            {/* Inline password entry */}
            <box class="password-row" spacing={8}
                visible={showPassword()}>
                <entry
                    hexpand
                    $={(self) => {
                        self.set_visibility(false)
                        self.set_placeholder_text("Password")
                        pwEntryRef = self
                        const key = new Gtk.EventControllerKey()
                        key.connect("key-pressed", (_: any, keyval: number) => {
                            if (keyval === Gdk.KEY_Return && pendingSSID) {
                                connectToAp(pendingSSID, self.get_text())
                                return true
                            }
                            return false
                        })
                        self.add_controller(key)
                    }}
                />
                <button class="connect-btn"
                    onClicked={() => {
                        if (pendingSSID && pwEntryRef) {
                            connectToAp(pendingSSID, pwEntryRef.get_text())
                        }
                    }}>
                    <label label="Connect" />
                </button>
            </box>
        </box>
    )
}

// ============================================================
//  BLUETOOTH DETAILS (expandable panel)
// ============================================================
function BluetoothDetails() {
    const devices = createBinding(bt, "devices")

    return (
        <box class="details-panel" orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            <box spacing={8}>
                <label class="detail-section-label" label="CONNECTED" hexpand xalign={0} />
                <button class="scan-btn"
                    onClicked={() => bt.adapter?.start_discovery()}>
                    <image iconName="view-refresh-symbolic" />
                </button>
            </box>

            <For each={devices}>
                {(dev) => (
                    <button class="detail-item connected"
                        visible={createBinding(dev, "connected")}
                        onClicked={() => dev.disconnect_device(null)}>
                        <box spacing={8}>
                            <image iconName={`${dev.icon}-symbolic`} />
                            <label label={dev.alias} hexpand xalign={0}
                                maxWidthChars={20} ellipsize={3} />
                            <label class="detail-status" label="Connected" />
                        </box>
                    </button>
                )}
            </For>

            <label class="detail-section-label" label="PAIRED" xalign={0} />

            <For each={devices}>
                {(dev) => (
                    <button class="detail-item"
                        visible={createBinding(dev, "connected")((c) => !c)}
                        onClicked={() => dev.connect_device(null)}>
                        <box spacing={8}>
                            <image iconName={`${dev.icon}-symbolic`} />
                            <label label={dev.alias} hexpand xalign={0}
                                maxWidthChars={20} ellipsize={3} />
                            <label class="detail-status" label="Paired" />
                        </box>
                    </button>
                )}
            </For>
        </box>
    )
}

// ============================================================
//  DND TOGGLE (uses notifd binding for persistent state)
// ============================================================
function DndToggle() {
    return (
        <button class="toggle-btn" hexpand
            $={(self) => {
                const update = () => {
                    if (notifd.dont_disturb) self.add_css_class("active")
                    else self.remove_css_class("active")
                }
                notifd.connect("notify::dont-disturb", update)
                update()
            }}
            onClicked={() => {
                notifd.set_dont_disturb(!notifd.dont_disturb)
            }}>
            <box spacing={8}>
                <image iconName={createBinding(notifd, "dontDisturb")((d) =>
                    d ? "notifications-disabled-symbolic"
                      : "preferences-system-notifications-symbolic"
                )} />
                <label label={createBinding(notifd, "dontDisturb")((d) => d ? "Do Not Disturb" : "Notifications")} />
            </box>
        </button>
    )
}

// ============================================================
//  POWER PROFILE TOGGLE (expandable)
// ============================================================
const profileModes = [
    { id: "quiet", label: "Quiet", icon: "weather-clear-night-symbolic" },
    { id: "balanced", label: "Balanced", icon: "power-profile-balanced-symbolic" },
    { id: "performance", label: "Performance", icon: "power-profile-performance-symbolic" },
]

function PowerProfileToggle() {
    return (
        <box class="toggle-btn"
            $={(self) => {
                const update = () => {
                    const p = currentProfile()
                    self.remove_css_class("profile-quiet")
                    self.remove_css_class("profile-balanced")
                    self.remove_css_class("profile-performance")
                    self.add_css_class(`profile-${p}`)
                    self.add_css_class("active")
                }
                update()
            }}>
            <button class="toggle-main" hexpand
                onClicked={() => {
                    execAsync(["asusctl", "profile", "next"])
                        .then(() => setCurrentProfile(getActiveProfile()))
                        .catch(() => {})
                }}>
                <box spacing={8}>
                    <image iconName={currentProfile((p: string) => {
                        const mode = profileModes.find(m => m.id === p)
                        return mode?.icon || "power-profile-balanced-symbolic"
                    })} />
                    <label label={currentProfile((p: string) => {
                        const mode = profileModes.find(m => m.id === p)
                        return mode?.label || "Balanced"
                    })} hexpand xalign={0} />
                </box>
            </button>
            <button class="toggle-arrow"
                onClicked={() => {
                    setProfileExpanded(!profileExpanded())
                }}>
                <image iconName={profileExpanded((e: boolean) => e ? "pan-down-symbolic" : "pan-end-symbolic")} />
            </button>
        </box>
    )
}

function PowerProfileDetails() {
    return (
        <box class="details-panel" orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            {profileModes.map((mode) => (
                <button class="detail-item"
                    $={(self) => {
                        const check = () => {
                            if (currentProfile() === mode.id) {
                                self.add_css_class("connected")
                            } else {
                                self.remove_css_class("connected")
                            }
                        }
                        check()
                    }}
                    onClicked={() => {
                        const name = mode.id.charAt(0).toUpperCase() + mode.id.slice(1)
                        execAsync(["asusctl", "profile", "set", name])
                            .then(() => setCurrentProfile(mode.id))
                            .catch(() => {})
                    }}>
                    <box spacing={8}>
                        <image iconName={mode.icon} />
                        <label label={mode.label} hexpand xalign={0} />
                        <label class="detail-status"
                            label={currentProfile((p: string) => p === mode.id ? "Active" : "")} />
                    </box>
                </button>
            ))}
        </box>
    )
}

// ============================================================
//  MEDIA PLAYER
// ============================================================
function lengthStr(length: number) {
    const min = Math.floor(length / 60)
    const sec = Math.floor(length % 60)
    return `${min}:${sec < 10 ? "0" : ""}${sec}`
}

function Player({ player }: { player: AstalMpris.Player }) {
    return (
        <box class="player" spacing={12}>
            <box
                class="cover"
                css={createBinding(player, "coverArt")((path) => `
                    min-width: 130px;
                    min-height: 130px;
                    background-image: url('${path || ""}');
                    background-size: cover;
                    border-radius: 8px;
                `)}
                valign={Gtk.Align.START}
            />
            <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                <box>
                    <label class="title" label={createBinding(player, "title")}
                        maxWidthChars={20} ellipsize={3} xalign={0} hexpand />
                    <image
                        class="player-icon"
                        iconName={`${player.entry}-symbolic`}
                        halign={Gtk.Align.END}
                    />
                </box>
                <label class="artist" label={createBinding(player, "artist")}
                    maxWidthChars={20} ellipsize={3} xalign={0} />
                <box vexpand />
                <box spacing={8} halign={Gtk.Align.CENTER}>
                    <button onClicked={() => player.previous()}
                        visible={createBinding(player, "canGoPrevious")}>
                        <image iconName="media-skip-backward-symbolic" />
                    </button>
                    <button class="play-pause" onClicked={() => player.play_pause()}
                        visible={createBinding(player, "canControl")}>
                        <image iconName={createBinding(player, "playbackStatus")((s) =>
                            s === AstalMpris.PlaybackStatus.PLAYING
                                ? "media-playback-pause-symbolic"
                                : "media-playback-start-symbolic"
                        )} />
                    </button>
                    <button onClicked={() => player.next()}
                        visible={createBinding(player, "canGoNext")}>
                        <image iconName="media-skip-forward-symbolic" />
                    </button>
                </box>
            </box>
        </box>
    )
}

function MediaWidget() {
    const players = createBinding(mpris, "players")

    return (
        <box orientation={Gtk.Orientation.VERTICAL} visible={players((p) => p.length > 0)}>
            <For each={players}>
                {(player) => <Player player={player} />}
            </For>
        </box>
    )
}

// ============================================================
//  CONTROL CENTER WINDOW
// ============================================================
export default function ControlCenter() {
    const { TOP, RIGHT } = Astal.WindowAnchor

    return (
        <window
            name="control-center"
            visible={false}
            application={app}
            anchor={TOP | RIGHT}
            layer={Astal.Layer.OVERLAY}
            keymode={Astal.Keymode.EXCLUSIVE}
            margin_top={10}
            margin_right={10}
            $={(self) => {
                self.connect("notify::is-active", () => {
                    if (!self.is_active) self.visible = false
                })
                const key = new Gtk.EventControllerKey()
                key.connect("key-pressed", (_: any, keyval: number) => {
                    if (keyval === Gdk.KEY_Escape) {
                        self.visible = false
                        return true
                    }
                    return false
                })
                self.add_controller(key)
            }}
        >
            <box class="control-center" orientation={Gtk.Orientation.VERTICAL} spacing={10}>
                <Header />

                {/* Power panel (expandable) */}
                <revealer
                    revealChild={powerExpanded}
                    transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                    transitionDuration={200}
                    $={(self) => {
                        self.connect("notify::child-revealed", () => {
                            if (!self.child_revealed) resetWindowSize()
                        })
                    }}>
                    <PowerPanel />
                </revealer>

                {/* Idle Timeouts panel (expandable) */}
                <revealer
                    revealChild={idleExpanded}
                    transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                    transitionDuration={200}
                    $={(self) => {
                        self.connect("notify::child-revealed", () => {
                            if (!self.child_revealed) resetWindowSize()
                        })
                    }}>
                    <IdleTimeoutsPanel />
                </revealer>

                {/* Audio & Display */}
                <label class="section-label" label="Audio & Display" xalign={0} />
                <box class="sliders" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                    <VolumeSlider />
                    <MicSlider />
                    <BrightnessSlider />
                </box>

                {/* Quick Settings */}
                <label class="section-label" label="Quick Settings" xalign={0} />
                <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                    {/* Row 1: WiFi + BT (expandable) */}
                    <box class="toggles" spacing={10} homogeneous>
                        <WifiToggle />
                        <BluetoothToggle />
                    </box>

                    {/* WiFi expandable panel */}
                    <revealer
                        revealChild={wifiExpanded}
                        transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                        transitionDuration={200}
                        $={(self) => {
                            self.connect("notify::child-revealed", () => {
                                if (!self.child_revealed) resetWindowSize()
                            })
                        }}>
                        <WifiDetails />
                    </revealer>

                    {/* Bluetooth expandable panel */}
                    <revealer
                        revealChild={btExpanded}
                        transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                        transitionDuration={200}
                        $={(self) => {
                            self.connect("notify::child-revealed", () => {
                                if (!self.child_revealed) resetWindowSize()
                            })
                        }}>
                        <BluetoothDetails />
                    </revealer>

                    {/* Row 2: DND + Power Profile */}
                    <box class="toggles" spacing={10} homogeneous>
                        <DndToggle />
                        <PowerProfileToggle />
                    </box>

                    {/* Power profile expandable panel */}
                    <revealer
                        revealChild={profileExpanded}
                        transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                        transitionDuration={200}
                        $={(self) => {
                            self.connect("notify::child-revealed", () => {
                                if (!self.child_revealed) resetWindowSize()
                            })
                        }}>
                        <PowerProfileDetails />
                    </revealer>
                </box>

                {/* Media */}
                <MediaWidget />
            </box>
        </window>
    )
}
