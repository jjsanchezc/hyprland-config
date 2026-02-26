import app from "ags/gtk4/app"
import { Astal, Gtk } from "ags/gtk4"
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

// ============================================================
//  HEADER
// ============================================================
function Header() {
    return (
        <box class="header" spacing={8}>
            <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                <box spacing={4} visible={createBinding(battery, "isPresent")}>
                    <image iconName={createBinding(battery, "iconName")} />
                    <label label={createBinding(battery, "percentage")((p) => `${Math.floor(p * 100)}%`)} />
                </box>
                <box spacing={4}>
                    <image iconName="preferences-system-time-symbolic" />
                    <label label={uptime} />
                </box>
            </box>
            <button class="sys-button" valign={Gtk.Align.CENTER}
                onClicked={() => execAsync(["bash", "-c", "ags quit; ags run"])}>
                <image iconName="emblem-synchronous-symbolic" />
            </button>
            <button class="sys-button" valign={Gtk.Align.CENTER}
                onClicked={() => execAsync(["pkill", "Hyprland"])}>
                <image iconName="system-log-out-symbolic" />
            </button>
            <button class="sys-button" valign={Gtk.Align.CENTER}
                onClicked={() => execAsync(["shutdown", "now"])}>
                <image iconName="system-shutdown-symbolic" />
            </button>
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
        </box>
    )
}

// ============================================================
//  WIFI TOGGLE
// ============================================================
function WifiToggle() {
    const wifi = network.wifi

    return (
        <button class="toggle-btn"
            $={(self) => {
                const update = () => {
                    if (wifi?.enabled) self.add_css_class("active")
                    else self.remove_css_class("active")
                }
                wifi?.connect("notify::enabled", update)
                update()
            }}
            onClicked={() => {
                if (wifi) {
                    wifi.enabled = !wifi.enabled
                    if (wifi.enabled) wifi.scan()
                }
            }}>
            <box spacing={8}>
                <image iconName={wifi ? createBinding(wifi, "iconName") : "network-wireless-offline-symbolic"} />
                <label label={wifi ? createBinding(wifi, "ssid")((s) => s || "Disconnected") : "No WiFi"} maxWidthChars={10} ellipsize={3} />
            </box>
        </button>
    )
}

// ============================================================
//  BLUETOOTH TOGGLE
// ============================================================
function BluetoothToggle() {
    return (
        <button class="toggle-btn"
            $={(self) => {
                const update = () => {
                    if (bt.is_powered) self.add_css_class("active")
                    else self.remove_css_class("active")
                }
                bt.connect("notify::is-powered", update)
                update()
            }}
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
                })} maxWidthChars={10} ellipsize={3} />
            </box>
        </button>
    )
}

// ============================================================
//  MIC MUTE TOGGLE
// ============================================================
function MicMuteToggle() {
    return (
        <button class="toggle-btn"
            $={(self) => {
                const update = () => {
                    if (mic.mute) self.add_css_class("active")
                    else self.remove_css_class("active")
                }
                mic.connect("notify::mute", update)
                update()
            }}
            onClicked={() => mic.set_mute(!mic.mute)}>
            <box spacing={8}>
                <image iconName={createBinding(mic, "mute")((m) =>
                    m ? "microphone-sensitivity-muted-symbolic" : "audio-input-microphone-symbolic"
                )} />
                <label label={createBinding(mic, "mute")((m) => m ? "Muted" : "Unmuted")} />
            </box>
        </button>
    )
}

// ============================================================
//  DND TOGGLE
// ============================================================
function DndToggle() {
    const [dnd, setDnd] = createState(false)

    return (
        <button class="toggle-btn"
            $={(self) => {
                if (dnd()) self.add_css_class("active")
                else self.remove_css_class("active")
            }}
            onClicked={() => {
                setDnd(!dnd())
                notifd.set_dont_disturb(!notifd.dont_disturb)
            }}>
            <box spacing={8}>
                <image iconName={dnd()
                    ? "notifications-disabled-symbolic"
                    : "preferences-system-notifications-symbolic"
                } />
                <label label={dnd() ? "Silent" : "Noisy"} />
            </box>
        </button>
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
        <box class="player" spacing={10}>
            <box
                class="cover"
                css={createBinding(player, "coverArt")((path) => `
                    min-width: 100px;
                    min-height: 100px;
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
            keymode={Astal.Keymode.ON_DEMAND}
            margin_top={8}
            margin_right={8}
        >
            <box class="control-center" orientation={Gtk.Orientation.VERTICAL} spacing={8}>
                <Header />

                {/* Sliders */}
                <box class="sliders" orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                    <VolumeSlider />
                    <MicSlider />
                    <BrightnessSlider />
                </box>

                {/* Toggle grid */}
                <box class="toggles" spacing={8} homogeneous>
                    <WifiToggle />
                    <BluetoothToggle />
                </box>
                <box class="toggles" spacing={8} homogeneous>
                    <MicMuteToggle />
                    <DndToggle />
                </box>

                {/* Media */}
                <MediaWidget />
            </box>
        </window>
    )
}
