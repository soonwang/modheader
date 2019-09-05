const SPECIAL_CHARS = '^$&+?.()|{}[]/'.split('');
const browser = chrome;
const modHeader = angular.module('modheader-popup', ['ngMaterial']);
modHeader.config(['$compileProvider', function ($compileProvider) {
  $compileProvider.debugInfoEnabled(false);
}]);

function fixProfile(profile) {
  if (profile.filters) {
    for (let filter of profile.filters) {
      if (filter.urlPattern) {
        const urlPattern = filter.urlPattern;
        const joiner = [];
        for (let i = 0; i < urlPattern.length; ++i) {
          let c = urlPattern.charAt(i);
          if (SPECIAL_CHARS.indexOf(c) >= 0) {
            c = '\\' + c;
          } else if (c == '\\') {
            c = '\\\\';
          } else if (c == '*') {
            c = '.*';
          }
          joiner.push(c);
        }
        delete filter.urlPattern;
        filter.urlRegex = joiner.join('');
      }
    }
  }
}

function toQueryString(obj) {
  let keys = obj && Object.keys(obj);
  let params;
  if (keys && keys.length > 0) {
      params = keys.map(key => `${key}=${obj[key]}`).join('&');
  }
  return params;
}

async function fetchKepTasks(currentPage = 1, taskList = []) {
    const pageSize = 20;
    const response = await fetch('http://kep-kl.netease.com/kep/api/work/data/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: toQueryString({
        source: 'relative',
        type: 'task',
        currentPage,
        pageSize,
        status: 'develop,measurement,test,testFinish,integrate'
      })
    })
    const json = await response.json();

    const list = json.data.list.map(item => ({
      id: item.id,
      title: item.title
    }));
    taskList = taskList.concat(list);

    if (list.length < pageSize) {
      return taskList;
    }
    return fetchKepTasks(currentPage + 1, taskList);
}

async function fetchRelatedTask(id, parentTaskId) {
  const response = await fetch(`http://kep-kl.netease.com/kep/api/work/data/relate/list?id=${id}&type=task`);
  const { data = {} } = await response.json();
  // 如果当前任务是 不是父任务，则获取 父任务的关联任务
  if (data.parentTask) {
    return fetchRelatedTask(data.parentTask.id, data.parentTask.id);
  }
  if (data.task) {
    const relatedIds = data.task.map(item => item.id);
    if (parentTaskId) {
      relatedIds.push(parentTaskId);
    }
    return relatedIds;
  }
  return [];
}

async function fetchTaskEnvName({ id, isRecursive = false }) {
  const response = await fetch(`http://kep-kl.netease.com/kep/api/work/develop/env/detail?id=${id}`)
  const json = await response.json();
  if (json.data.name) {
    return json.data.name
  }
  if (isRecursive) {
    // 获取 关联的 任务id
    const relatedIds = await fetchRelatedTask(id);
    // 去重
    const matchedId = relatedIds.findIndex(relatedId => relatedId == id);
    if (matchedId >= 0) {
      relatedIds.splice(matchedId, 1);
    }
    let taskName = '';
    for(taskId of relatedIds) {
      const name = await fetchTaskEnvName({ id: taskId, isRecursive: false });
      if (name) {
        taskName = name;
        break;
      }
    }
    return taskName;
  }
  return '';
}

modHeader.factory('dataSource', function($timeout, $mdToast) {
  var dataSource = {};

  var isExistingProfileTitle_ = function(title) {
    for (var i = 0; i < dataSource.profiles.length; ++i) {
      if (dataSource.profiles[i].title == title) {
        return true;
      }
    }
    return false;
  };

  var emptyEntranceEnv = function(headers) {
    const index = headers.findIndex(header => header.name === 'entranceEnv' || !header.name);
    if (index < 0) {
      return;
    }
    headers.splice(index, 1);
    return emptyEntranceEnv(headers);
  }

  dataSource.addFilter = function(filters) {
    let urlRegex = '';
    if (localStorage.currentTabUrl) {
      const parser = document.createElement('a');
      parser.href = localStorage.currentTabUrl;
      urlRegex = parser.origin + '/.*';
    }
    filters.push({
      enabled: true,
      type: 'urls',
      urlRegex: urlRegex
    });
  };

  dataSource.sync = async function(headers) {
    try {
      const tasks = await fetchKepTasks();
      if (tasks && tasks.length) {
        // 清空 当前环境标
        emptyEntranceEnv(headers);
        ['stable_prejd','stable_masterjd'].forEach(value => {
          headers.push({
            enabled: false,
            name: 'entranceEnv',
            value,
            comment: ''
          })
        })
      }
      tasks.forEach(async (task) => {
        const taskName = await fetchTaskEnvName({
          id: task.id,
          isRecursive: true
        });
        if (taskName) {
          $timeout(() => {
            headers.push({
              enabled: false,
              name: 'entranceEnv',
              value: taskName,
              comment: task.title
            })
            dataSource.save();
          }, 1)
        }
      });
    } catch (err) {
      $mdToast.show({
        position: 'bottom',
        controller: 'ToastCtrl',
        controllerAs: 'ctrl',
        bindToController: true,
        locals: {toastMessage: '请先登录KEP', buttonText: '前往登录', url: 'http://kep-kl.netease.com/'},
        templateUrl: 'footer.tmpl.html',
        hideDelay: 0
      });
    }
  };

  dataSource.toggleHeader = function(headers, header) {
    const headerEnabled = header.enabled;
    const headerName = header.name;
    headers.forEach(item => {
      if (item.name === headerName) {
        item.enabled = false;
      }
    });
    header.enabled = !!headerEnabled;
    $timeout(() => {
      dataSource.save();
    }, 1)
  };

  dataSource.addHeader = function(headers) {
    headers.push({
      enabled: true,
      name: '',
      value: '',
      comment: ''
    });
  };

  dataSource.removeFilter = function(filters, filter) {
    filters.splice(filters.indexOf(filter), 1);
  };

  dataSource.removeHeader = function(headers, header) {
    headers.splice(headers.indexOf(header), 1);
  };

  dataSource.removeHeaderEnsureNonEmpty = function(headers, header) {
    dataSource.removeHeader(headers, header);
    if (!headers.length) {
      dataSource.addHeader(headers);
    }
  };

  dataSource.pause = function() {
    dataSource.isPaused = true;
    localStorage.isPaused = true;
    $mdToast.show(
      $mdToast.simple()
        .content('ModHeader paused')
        .position('bottom')
        .hideDelay(1000)
    );
  };

  dataSource.play = function() {
    dataSource.isPaused = false;
    localStorage.removeItem('isPaused');
    $mdToast.show(
      $mdToast.simple()
        .content('ModHeader unpaused')
        .position('bottom')
        .hideDelay(1000)
    );
  };

  dataSource.lockToTab = function() {
    dataSource.lockedTabId = localStorage.activeTabId;
    localStorage.lockedTabId = dataSource.lockedTabId;
    $mdToast.show(
      $mdToast.simple()
        .content('Restricted ModHeader to the current tab')
        .position('bottom')
        .hideDelay(1000)
    );
  };

  dataSource.unlockAllTab = function() {
    dataSource.lockedTabId = null;
    localStorage.removeItem('lockedTabId');
    $mdToast.show(
      $mdToast.simple()
        .content('Applying ModHeader to all tabs')
        .position('bottom')
        .hideDelay(1000)
    );
  };

  dataSource.hasDuplicateHeaderName = function(headers, name) {
    for (var i = 0; i < headers.length; ++i) {
      var header = headers[i];
      if (header.enabled && header.name == name) {
        return true;
      }
    }
    return false;
  };

  dataSource.createProfile = function() {
    let index = 1;
    while (isExistingProfileTitle_('Profile ' + index)) {
      ++index;
    }
    const profile = {
        title: 'Profile ' + index,
        hideComment: false,
        headers: [],
        respHeaders: [],
        filters: [],
        appendMode: ''
    };
    dataSource.addHeader(profile.headers);
    return profile;
  };
  dataSource.predicate = '';
  dataSource.reverse = false;

  if (localStorage.profiles) {
    dataSource.profiles = angular.fromJson(localStorage.profiles);
    for (let profile of dataSource.profiles) {
      fixProfile(profile);
    }
  } else {
    dataSource.profiles = [];
  }
  if (dataSource.profiles.length == 0) {
    dataSource.profiles.push(dataSource.createProfile());
  }
  for (let index in dataSource.profiles) {
    const profile = dataSource.profiles[index];
    if (!profile.title) {
      profile.title = 'Profile ' + (index + 1);
    }
    if (!profile.headers) {
      profile.headers = [];
      dataSource.addHeader(profile.headers);
    }
    if (!profile.respHeaders) {
      profile.respHeaders = [];
      dataSource.addHeader(profile.respHeaders);
    }
    if (!profile.filters) {
      profile.filters = [];
    }
    if (!profile.appendMode) {
      profile.appendMode = '';
    }
  }
  if (localStorage.selectedProfile) {
    dataSource.selectedProfile = dataSource.profiles[Number(localStorage.selectedProfile)];
  }
  if (!dataSource.selectedProfile) {
    dataSource.selectedProfile = dataSource.profiles[0];
  }
  if (localStorage.isPaused) {
    dataSource.isPaused = localStorage.isPaused;
  }
  if (localStorage.lockedTabId) {
    dataSource.lockedTabId = localStorage.lockedTabId;
  }
  dataSource.save = function() {
    var serializedProfiles = angular.toJson(dataSource.profiles);
    var selectedProfileIndex = dataSource.profiles.indexOf(dataSource.selectedProfile);
    localStorage.profiles = serializedProfiles;
    localStorage.selectedProfile = selectedProfileIndex;
  };
  return dataSource;
});

modHeader.factory('profileService', function(
    $timeout, $mdSidenav, $mdUtil, $mdDialog, $mdToast, dataSource) {
  var profileService = {};

  var closeOptionsPanel_ = function() {
    $mdSidenav('left').close();
  };

  var updateSelectedProfile_ = function() {
   $timeout(function() {
      dataSource.selectedProfile = dataSource.profiles[dataSource.profiles.length - 1];
    }, 1);
  };

  profileService.selectProfile = function(profile) {
    dataSource.selectedProfile = profile;
    closeOptionsPanel_();
  };

  profileService.addProfile = function() {
    dataSource.profiles.push(dataSource.createProfile());
    updateSelectedProfile_();
    closeOptionsPanel_();
  };

  profileService.cloneProfile = function(profile) {
    var newProfile = angular.copy(profile);
    newProfile.title = 'Copy of ' + newProfile.title;
    dataSource.profiles.push(newProfile);
    updateSelectedProfile_();
  };

  profileService.deleteProfile = function(profile) {
    dataSource.profiles.splice(dataSource.profiles.indexOf(profile), 1);
    if (dataSource.profiles.length == 0) {
      profileService.addProfile();
    } else {
      updateSelectedProfile_();
    }
  };

  profileService.exportProfile = function(event, profile) {
    var parentEl = angular.element(document.body);
    $mdDialog.show({
      parent: parentEl,
      targetEvent: event,
      focusOnOpen: false,
      templateUrl: 'exportdialog.tmpl.html',
      locals: {
        title: profile.title,
        profile: angular.toJson(profile)
      },
      controller: DialogController_
    });
    function DialogController_($scope, $mdDialog, $mdToast, title, profile) {
      $scope.title = title;
      $scope.profile = profile;

      $scope.copy = function() {
        document.getElementById('exportedProfile').select();
        document.execCommand('copy');
        $mdToast.show(
          $mdToast.simple()
            .content('Copied to clipboard!')
            .position('top')
            .hideDelay(1000)
        );
      };

      $scope.closeDialog = function() {
        $mdDialog.hide();
      };
    }
  };

  profileService.importProfile = function(event, profile) {
    var parentEl = angular.element(document.body);
    $mdDialog.show({
      parent: parentEl,
      targetEvent: event,
      focusOnOpen: false,
      templateUrl: 'importdialog.tmpl.html',
      locals: {
        profile: profile
      },
      controller: DialogController_
    }).then(function(importProfile) {
      try {
        angular.copy(angular.fromJson(importProfile), profile);
        fixProfile(profile);
        $mdToast.show(
          $mdToast.simple()
            .content('Profile successfully import')
            .position('top')
            .hideDelay(1000)
        );
      } catch (e) {
        $mdToast.show(
          $mdToast.simple()
            .content('Failed to import profile')
            .position('top')
            .hideDelay(1000)
        );
      }
    });
    function DialogController_($scope, $mdDialog, profile) {
      $scope.importProfile = '';

      $scope.closeDialog = function() {
        $mdDialog.hide($scope.importProfile);
      };
    }
  };

  profileService.openSettings = function(event, profile) {
    var parentEl = angular.element(document.body);
    $mdDialog.show({
      parent: parentEl,
      targetEvent: event,
      focusOnOpen: false,
      templateUrl: 'settings.tmpl.html',
      locals: {
        profile: profile
      },
      controller: DialogController_
    });
    function DialogController_($scope, $mdDialog, profile) {
      $scope.profile = profile;

      $scope.closeDialog = function() {
        $mdDialog.hide();
      };
    }
  };

  profileService.openCloudBackup = (event) => {
    const parentEl = angular.element(document.body);
    $mdDialog.show({
      parent: parentEl,
      targetEvent: event,
      focusOnOpen: false,
      templateUrl: 'cloudbackupdialog.tmpl.html',
      controller: DialogController_
    }).then((profiles) => {
      if (!profiles) {
        return;
      }
      try {
        dataSource.profiles = profiles;
        dataSource.selectedProfile = dataSource.profiles[0];
        dataSource.save();

        $mdToast.show(
          $mdToast.simple()
            .content('Profiles successfully import')
            .position('top')
            .hideDelay(1000)
        );
      } catch (e) {
        $mdToast.show(
          $mdToast.simple()
            .content('Failed to import profiles')
            .position('top')
            .hideDelay(1000)
        );
      }
    });
    function DialogController_($scope, $mdDialog) {
      browser.storage.sync.get(null, (items) => {
          let savedData = [];
          if (!items) {
            items = [];
          }
          for (const key in items) {
            try {
              const serializedProfiles = items[key];
              const profiles = angular.fromJson(serializedProfiles);
              for (let profile of profiles) {
                fixProfile(profile);
              }
              savedData.push({
                'timeInMs': key,
                'profiles': profiles,
              });
            } catch(e) {
              // skip invalid profile.
            }
          }
          $scope.savedData = savedData;
        });

      $scope.selectProfiles = function(profiles) {
        $mdDialog.hide(profiles);
      };

      $scope.closeDialog = function() {
        $mdDialog.hide();
      };
    }
  };
  return profileService;
});

modHeader.factory('autocompleteService', function(
    dataSource) {
  var autocompleteService = {};

  autocompleteService.requestHeaderNames = [
    'Authorization',
    'Cache-Control',
    'Connection',
    'Content-Length',
    'Host',
    'If-Modified-Since',
    'If-None-Match',
    'If-Range',
    'Partial-Data',
    'Pragma',
    'Proxy-Authorization',
    'Proxy-Connection',
    'Transfer-Encoding',
    'Accept',
    'Accept-Charset',
    'Accept-Encoding',
    'Accept-Language',
    'Accept-Datetime',
    'Cookie',
    'Content-MD5',
    'Content-Type',
    'Date',
    'Expect',
    'From',
    'If-Match',
    'If-Unmodified-Since',
    'Max-Forwards',
    'Origin',
    'Range',
    'Referer',
    'TE',
    'User-Agent',
    'Upgrade',
    'Via',
    'Warning',
    'X-Forwarded-For',
    'X-Forwarded-Host',
    'X-Forwarded-Proto',
    'Front-End-Https',
    'X-Http-Method-Override',
    'X-ATT-DeviceId',
    'X-Wap-Profile',
    'X-UIDH',
    'X-Csrf-Token'];
  autocompleteService.requestHeaderValues = [];
  autocompleteService.responseHeaderNames = [
    'Access-Control-Allow-Origin',
    'Accept-Patch',
    'Accept-Ranges',
    'Age',
    'Allow',
    'Connection',
    'Content-Disposition',
    'Content-Encoding',
    'Content-Language',
    'Content-Length',
    'Content-Location',
    'Content-MD5',
    'Content-Range',
    'Content-Type',
    'Date',
    'ETag',
    'Expires',
    'Last-Modified',
    'Link',
    'Location',
    'P3P',
    'Pragma',
    'Proxy-Authenticate',
    'Public-Key-Pins',
    'Refresh',
    'Retry-After',
    'Server',
    'Set-Cookie',
    'Strict-Transport-Security',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
    'Vary',
    'Via',
    'Warning',
    'WWW-Authenticate',
    'X-Frame-Options',
    'X-XSS-Protection',
    'Content-Security-Policy',
    'X-Content-Type-Options',
    'X-Powered-By',
    'X-UA-Compatible',
    'X-Content-Duration',
    'X-Content-Security-Policy',
    'X-WebKit-CSP',
  ];
  autocompleteService.responseHeaderValues = [];

  function createFilterFor_(query) {
    const lowercaseQuery = query.toLowerCase();
    return function filterFn(item) {
      return (item.toLowerCase().indexOf(lowercaseQuery) == 0);
    };
  }

  autocompleteService.query = function(cache, sourceHeaderList, field, query) {
    if (!query || query.length < 2) {
      return [];
    }
    for (let header of sourceHeaderList) {
      if (header[field] != query && cache.indexOf(header[field]) < 0) {
        cache.push(header[field]);
      }
    }
    return cache.filter(createFilterFor_(query));
  };
  return autocompleteService;
});

modHeader.controller('SortingController', function($filter, dataSource) {
  this.order = function(profile, predicate) {
    dataSource.reverse = (dataSource.predicate === predicate)
        ? !dataSource.reverse : false;
    dataSource.predicate = predicate;
    var orderBy = $filter('orderBy');
    profile.headers = orderBy(
        profile.headers, dataSource.predicate, dataSource.reverse);
    profile.respHeaders = orderBy(
        profile.respHeaders, dataSource.predicate, dataSource.reverse);
  };
});

modHeader.controller('AppController', function(
    $scope, $mdSidenav, $mdUtil, $window, $mdToast,
    dataSource, profileService, autocompleteService) {
  $scope.toggleSidenav = $mdUtil.debounce(function() {
    $mdSidenav('left').toggle();
  }, 300);

  $window.onunload = function(e) {
    dataSource.save();
  };

  $scope.openLink = function(link) {
    browser.tabs.create({url: link});
  };

  $scope.autocompleteService = autocompleteService;
  $scope.dataSource = dataSource;
  $scope.profileService = profileService;

});


modHeader.controller('ToastCtrl', function($mdToast, $scope) {
  let ctrl = this;

  ctrl.goToUrl = function(url) {
    browser.tabs.create({url: url});
  };

  ctrl.dismiss = function() {
    if (localStorage.numTipDismiss) {
      localStorage.numTipDismiss++;
    } else {
      localStorage.numTipDismiss = 1;
    }
    $mdToast.hide();
  };
});
