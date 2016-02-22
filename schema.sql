DROP SCHEMA IF EXISTS schedule_calculator;
CREATE SCHEMA schedule_calculator AUTHORIZATION schedule_calculator

    CREATE TABLE schedules (
      user_id TEXT,
      schedule_id INT,
      PRIMARY KEY (user_id, schedule_id),
      data TEXT
    )

    CREATE TABLE subscriptions (
      user_id TEXT,
      endpoint TEXT,
      subscription_id TEXT,
      UNIQUE (user_id, endpoint, subscription_id)
    )
