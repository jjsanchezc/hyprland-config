import app from "ags/gtk4/app"
import { Astal, Gtk } from "ags/gtk4"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"

const notifd = AstalNotifd.get_default()
const MAX_POPUPS = 3
const DEFAULT_TIMEOUT = 4000

function NotificationPopup(notification: AstalNotifd.Notification, onDone: () => void) {
    const urgency = notification.get_urgency()
    const isCritical = urgency === AstalNotifd.Urgency.CRITICAL

    let timeoutId: number | null = null
    let destroyed = false

    const destroy = () => {
        if (destroyed) return
        destroyed = true
        if (timeoutId) GLib.source_remove(timeoutId)
        revealer.revealChild = false
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            outer.unparent()
            onDone()
            return GLib.SOURCE_REMOVE
        })
    }

    // Auto-dismiss all notifications (critical gets more time)
    const timeout = isCritical
        ? 6000
        : (notification.get_expire_timeout() > 0
            ? notification.get_expire_timeout()
            : DEFAULT_TIMEOUT)
    timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
        timeoutId = null
        destroy()
        return GLib.SOURCE_REMOVE
    })

    // Listen for external resolve
    const resolvedId = notifd.connect("resolved", (_: any, id: number) => {
        if (id === notification.get_id()) {
            notifd.disconnect(resolvedId)
            destroy()
        }
    })

    const body = notification.get_body()
    const cssClass = isCritical ? "notification critical" : "notification"

    const content = (
        <button cssClasses={[cssClass]}
            onClicked={() => {
                notification.dismiss()
                notifd.disconnect(resolvedId)
                destroy()
            }}>
            <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                <label cssClasses={["notif-app"]}
                    label={notification.get_app_name() || "Notification"}
                    xalign={0} maxWidthChars={40} ellipsize={3} />
                <label cssClasses={["notif-summary"]}
                    label={notification.get_summary()}
                    xalign={0} maxWidthChars={40} ellipsize={3} />
                {body ? (
                    <label cssClasses={["notif-body"]}
                        label={body}
                        xalign={0} wrap maxWidthChars={40} />
                ) : <box />}
            </box>
        </button>
    )

    const revealer = (
        <revealer
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
            transitionDuration={200}>
            {content}
        </revealer>
    ) as Gtk.Revealer

    const outer = <box>{revealer}</box>

    // Slide in on next frame
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
        revealer.revealChild = true
        return GLib.SOURCE_REMOVE
    })

    return { widget: outer, destroy, notificationId: notification.get_id() }
}

export default function Notifications() {
    const { TOP, RIGHT } = Astal.WindowAnchor
    const popups: { widget: Gtk.Widget; destroy: () => void; notificationId: number }[] = []

    const container = (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={6}
            halign={Gtk.Align.END} valign={Gtk.Align.START} />
    ) as Gtk.Box

    notifd.connect("notified", (_: any, id: number, replaced: boolean) => {
        if (notifd.dont_disturb) return

        // If replaced, remove old popup for same id
        if (replaced) {
            const idx = popups.findIndex(p => p.notificationId === id)
            if (idx >= 0) {
                popups[idx].destroy()
                popups.splice(idx, 1)
            }
        }

        const notification = notifd.get_notification(id)
        if (!notification) return

        const popup = NotificationPopup(notification, () => {
            const idx = popups.indexOf(popup)
            if (idx >= 0) popups.splice(idx, 1)
        })

        container.prepend(popup.widget)
        popups.unshift(popup)

        // Enforce max popups
        while (popups.length > MAX_POPUPS) {
            const oldest = popups.pop()!
            oldest.destroy()
        }
    })

    return (
        <window
            name="notifications"
            visible
            application={app}
            anchor={TOP | RIGHT}
            layer={Astal.Layer.OVERLAY}
            keymode={Astal.Keymode.NONE}
            margin_top={10}
            margin_right={10}
            namespace="notifications">
            {container}
        </window>
    )
}

export function dismissLatest() {
    const notifs = notifd.get_notifications()
    if (notifs.length > 0) notifs[0].dismiss()
}

export function dismissAll() {
    for (const n of notifd.get_notifications()) n.dismiss()
}
