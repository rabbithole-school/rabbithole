Pod::Spec.new do |s|
  s.name           = 'BugReportGesture'
  s.version        = '1.0.0'
  s.summary        = 'Window-level bug-report gesture for Rabbithole'
  s.description    = 'A local Expo module that installs a simultaneous three-finger stationary hold recognizer on the active iOS key window and emits began, ended, and cancelled phases to JavaScript.'
  s.author         = 'Rabbithole'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.frameworks = 'UIKit'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
