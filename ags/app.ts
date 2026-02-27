import app from "ags/gtk4/app"
import style from "./style.scss"
import ControlCenter from "./widget/ControlCenter"
import Notifications, { dismissLatest, dismissAll } from "./widget/Notifications"

app.start({
    css: style,
    instanceName: "jjsanchezc-shell",
    requestHandler(request, response) {
        if (request === "toggle-cc") {
            app.toggle_window("control-center")
            response("toggled")
        } else if (request === "dismiss-notif") {
            dismissLatest()
            response("dismissed")
        } else if (request === "dismiss-all") {
            dismissAll()
            response("dismissed all")
        } else {
            response("unknown command")
        }
    },
    main() {
        ControlCenter()
        Notifications()
    },
})
