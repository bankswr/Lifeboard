package org.lifeboard.app.widgets;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * Receives Calendar widget row taps without showing anything (Theme.NoDisplay, own task, so
 * the app isn't brought forward). A task row's tap is queued as a tick and the widget redrawn;
 * any other row opens the app at the row's page (the tap's lifeboard:// link).
 */
public class CalendarTapActivity extends Activity {

    static final String EXTRA_TASK = "taskId";
    static final String EXTRA_DONE = "done";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent tap = getIntent();
        if (tap.hasExtra(EXTRA_TASK)) {
            WidgetStore.queueTick(this, WidgetStore.TASK_TICKS, tap.getStringExtra(EXTRA_TASK), tap.getBooleanExtra(EXTRA_DONE, true));
            RowsWidget.redrawAll(this, new CalendarWidget());
        } else if (tap.getData() != null) {
            startActivity(new Intent(Intent.ACTION_VIEW, tap.getData()).setPackage(getPackageName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        finish();
    }
}
