package org.lifeboard.app.widgets;

/** Today's tasks and events, then upcoming events: the snapshot's "calendar" part. */
public class CalendarWidget extends RowsWidget {

    @Override
    String key() {
        return "calendar";
    }
}
