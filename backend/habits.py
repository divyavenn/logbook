"""Habits: each is its own record, drawn as a task until its day is done.

A habit is never an entry. Today's list shows every live habit with no
habit_days row for today, so a missed day needs nothing done to it: it is
simply a day with no row. A done day is shown in the logbook from its row.
"""
from datetime import date, timedelta

from fastapi import HTTPException


def live_habits(db):
    return db.execute('SELECT * FROM habits WHERE archived_at IS NULL ORDER BY position, id').fetchall()


def required_habit(db, habit_id):
    row = db.execute('SELECT * FROM habits WHERE id = ? AND archived_at IS NULL', (habit_id,)).fetchone()
    if row is None:
        raise HTTPException(404, 'That habit no longer exists.')
    return row


def due(db, today):
    """The habits still to do today, as the task list shows them, each with
    the run of days it is on: the days done up to yesterday."""
    rows = db.execute(
        '''SELECT * FROM habits WHERE archived_at IS NULL
           AND id NOT IN (SELECT habit_id FROM habit_days WHERE date = ?) ORDER BY position, id''', (today,)).fetchall()
    result = []
    for row in rows:
        done = {day['date'] for day in db.execute('SELECT date FROM habit_days WHERE habit_id = ? AND date < ?', (row['id'], today))}
        day, streak = date.fromisoformat(today) - timedelta(days=1), 0
        while day.isoformat() in done:
            streak += 1
            day -= timedelta(days=1)
        result.append({'id': row['id'], 'key': row['key'], 'name': row['name'], 'streak': streak})
    return result


def done_on(db, dates):
    """The habits done on each date, given up ones included, as the logbook shows them."""
    result = {}
    if not dates:
        return result
    for row in db.execute(f'''SELECT habits.id, habits.key, habits.name, habits.archived_at, habit_days.date, habit_days.completed_at
                              FROM habit_days JOIN habits ON habits.id = habit_days.habit_id
                              WHERE habit_days.date IN ({','.join('?' for _ in dates)})
                              ORDER BY habit_days.completed_at, habits.position, habits.id''', list(dates)):
        result.setdefault(row['date'], []).append({
            'id': row['id'], 'key': row['key'], 'name': row['name'],
            'completed_at': row['completed_at'], 'archived': row['archived_at'] is not None})
    return result


def history(db, start, end):
    """The days each habit was done, oldest first."""
    done = {}
    for row in db.execute('SELECT habit_id, date FROM habit_days WHERE date BETWEEN ? AND ? ORDER BY date', (start, end)):
        done.setdefault(row['habit_id'], []).append(row['date'])
    return done


def habit_dict(row, done):
    return {'id': row['id'], 'key': row['key'], 'name': row['name'], 'position': row['position'],
            'created_at': row['created_at'], 'done': done.get(row['id'], [])}
