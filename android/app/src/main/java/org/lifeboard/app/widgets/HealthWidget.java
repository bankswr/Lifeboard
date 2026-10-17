package org.lifeboard.app.widgets;

/** Today's health targets: the snapshot's "health" part (src/core/widgets.ts). */
public class HealthWidget extends RowsWidget {

    @Override
    String key() {
        return "health";
    }
}
