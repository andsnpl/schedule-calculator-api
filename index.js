var fs = require('fs');
var path = require('path');
var https = require('https');
var request = require('request');
var express = require('express');
var bodyParser = require('body-parser');
var cors = require('cors');
var pg = require('pg');
var Q = require('q');

var keyLocation = path.resolve(__dirname, '../private/server.key');
var certLocation = path.resolve(__dirname, '../private/server.crt');
var credentials = {
  key: fs.readFileSync(keyLocation, 'utf-8').trim(),
  cert: fs.readFileSync(certLocation, 'utf-8').trim()
};

var dbPassLocation = path.resolve(__dirname, '../private/database.pass');
var dbPassword = fs.readFileSync(dbPassLocation, 'utf-8').trim();
var conString
  = `postgres://schedule_calculator:${dbPassword}`
  + '@localhost/schedule_calculator';

var apiKeyLocation = path.resolve(__dirname, '../private/api.key');
var apiKey = fs.readFileSync(apiKeyLocation, 'utf-8').trim();

var app = express();
app.use(bodyParser.json());
app.use(cors({
  origin: [
    /https?:\/\/localhost:8080/,
    /https?:\/\/127\.0\.0\.1:8080/
  ]
}));

var connect = function (res, clientFn) {
  pg.connect(conString, function (err, client, done) {
    if (err) {
      return send500(res, 'could not connect to database', err);
    }
    clientFn(client, done);
  });
};

var runQuery = function (res, query, params, callback) {
  return connect(res, function (client, done) {
    client.query(query, params, function (err, result) {
      done();
      if (err) {
        return send500(res, 'query ' + query + ' failed', err);
      } else if (!result.rows.length) {
        res.end();
      } else if (callback) {
        callback(result.rows);
      } else {
        res.end();
      }
    });
  });
};

var runQuerySingleResult = function (res, query, params, callback) {
  return runQuery(res, query, params, function (rows) {
    if (rows.length > 1) {
      return send500(
        res, 'query ' + query + ' returned too many results', results);
    } else if (callback) {
      callback(res, rows[0]);
    } else {
      res.end();
    }
  });
};

var send500 = function (res, message, details) {
  console.error('Returning 500', details);
  res.status(500).send(message);
};

var cleanUpSchedules = function (schedulesToAdd, schedulesToDelete) {
  connect(res, function (client, done) {
    try {
      schedulesToDelete.forEach(function (scheduleId) {
        client.query(
          'DELETE FROM schedules WHERE user_id = $1 AND schedule_id = $2',
          [userId, scheduleId]
        );
      });

      receivedSchedules.forEach(function (sched) {
        if (schedulesToAdd.indexOf(sched.id) + 1) {
          client.query(
            'INSERT INTO schedules (user_id, schedule_id, data) '
            + 'VALUES ($1, $2, $3)',
            [userId, sched.id, JSON.stringify(sched)]
          );
        }
      });
    } catch (err) {
      return send500(res, '', err);
    } finally {
      done();
    }
  });
};

// return the user_id of employees who are working the specified shifts
var usersInSchedule = function (employeeMap, shifts) {
  console.log(employeeMap);
  return shifts.map(function (shift) {
    var employeeId = shift.employeeId;
    return employeeMap[employeeId].userId;
  });
}

// return a function that returns true if a passed row object has a user_id
// matching an employee who is part of one of the specified shifts
var notificationFilterer = function (employeeMap, shifts) {
  var userIds = usersInSchedule(employeeMap, shifts);
  return function (row) {
    return userIds.indexOf(row.user_id) + 1;
  };
};

var sendNotification = function (endpoint, subscriptionId, message) {
  if (subscriptionId) {
    // GCM usage
    request.post({
      uri: endpoint,
      json: true,
      headers: {
        Authorization: `key=${apiKey}`
      },
      body: {
        to: subscriptionId
      }
    });
  } else {
    request.post({
      uri: endpoint,
      json: true,
      body: {
        message: message
      }
    });
  }
};

app.post('/subscribe', function (req, res) {
  console.log('received subscribe', req.body);
  // save the information necessary to send notifications to the device
  var userId = req.body.userId;
  var endpoint = req.body.endpoint;
  var GCM_ENDPOINT = 'https://android.googleapis.com/gcm/send';
  var subscriptionId;

  if (endpoint.indexOf(GCM_ENDPOINT) === 0) {
    var endpointParts = endpoint.split('/');
    subscriptionId = endpointParts.pop();
    endpoint = GCM_ENDPOINT;
  }

  runQuery(
    res,
    'INSERT INTO subscriptions (user_id, endpoint, subscription_id) '
    + 'VALUES ($1, $2, $3)',
    [userId, endpoint, subscriptionId]
  );
});

app.post('/user-data/:userId', function (req, res) {
  console.log('received user data', req.body);
  var userId = req.body.userId;
  var receivedSchedules = req.body.schedules;
  var receivedScheduleIds = receivedSchedules.map(function (sched) {
    return sched.id;
  });

  runQuery(
    res,
    'SELECT schedule_id, data FROM schedules WHERE user_id = $1',
    [userId],
    function (rows) {
      var schedulesToAdd = receivedScheduleIds.slice();
      var schedulesToDelete = [];
      var schedules = [];

      try {
        schedules = result.rows.map(function (row) {
          var idx = receivedScheduleIds.indexOf(row.id);
          if (idx < 0) {
            // If the result row doesn't exist in the client data
            schedulesToDelete.push(row.id);
          } else {
            // If the same schedule is in both the db and the client data
            schedulesToAdd.splice(idx, 1);
          }
          return row.data;
        });
      } catch (err) {
        return send500(res, 'error retrieving schedules from database', err);
      } finally {
        res.json({
          schedules: schedules
        });
      }

      if (schedulesToAdd.length || schedulesToDelete.length) {
        cleanUpSchedules(schedulesToAdd, schedulesToDelete);
      }
    }
  );
});

app.post('/schedule', function (req, res) {
  console.log('received schedule', req.body);
  var userId = req.body.userId;
  var scheduleId = req.body.id;
  var data = JSON.stringify(req.body.data);

  var savedSchedule = new Q.Promise(function (resolve, reject) {
    runQuery(
      res,
      'DELETE FROM schedules WHERE user_id = $1 AND schedule_id = $2',
      [userId, scheduleId],
      function () {
        runQuery(
          res,
          'INSERT INTO schedules (user_id, schedule_id, data) '
          + 'VALUES ($1, $2, $3)',
          [userId, scheduleId, data],
          resolve
        );
      }
    );

    res.on('close finish', function () {
      // If resolve() happens first, then this is a no-op
      reject('problem saving schedule');
    });
  });

  runQuery(
    res,
    'SELECT user_id, endpoint, subscription_id FROM subscriptions',
    [],
    function (rows) {
      var employees = data.employeeList.employees;
      rows = rows.filter(notificationFilterer(employees, data.schedule.shifts));
      savedSchedule.then(function () {
        res.end();
        rows.forEach(function (row) {
          var endpoint = row.endpoint;
          var subscriptionId = row.subscription_id;

          sendNotification(
            endpoint, subscriptionId,
            'new data for schedule ' + scheduleId
          );
        });
      });
    }
  );
});

app.get('/schedule/:userId/:scheduleId', function (req, res) {
  console.log('getting schedule for', req.params.id);
  // get the schedule as JSON
  var userId = req.params.userId;
  var scheduleId = req.params.scheduleId;

  runQuerySingleResult(
    res,
    'SELECT data FROM schedules WHERE user_id = $1 AND schedule_id = $2',
    [userId, scheduleId],
    function (row) {
      res.send(row.data);
    }
  );
});

https.createServer(credentials, app).listen(8081);
