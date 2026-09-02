Pod::Spec.new do |s|
  s.name           = 'HardwareKeyboard'
  s.version        = '1.0.0'
  s.summary        = 'Detects a connected hardware keyboard for Rabbithole'
  s.description    = 'A local Expo module that reports whether a physical (hardware) keyboard is connected, via the GameController framework GCKeyboard API, and emits connect/disconnect events.'
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

  s.frameworks = 'GameController'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
