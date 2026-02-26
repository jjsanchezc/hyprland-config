import app from "ags/gtk4/app"
import style from "./style.scss"
import ControlCenter from "./widget/ControlCenter"

app.start({
    css: style,
    instanceName: "jjsanchezc-shell",
    requestHandler(request, response) {
        if (request === "toggle-cc") {
            app.toggle_window("control-center")
            response("toggled")
        }
        response("unknown command")
    },
    main() {
        ControlCenter()
    },
})
