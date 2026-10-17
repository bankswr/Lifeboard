package org.lifeboard.app.widgets;

/** Current alerts, not dismissed: the snapshot's "alerts" part. */
public class AlertsWidget extends RowsWidget {

    @Override
    String key() {
        return "alerts";
    }
}
