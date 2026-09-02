Pod::Spec.new do |s|
  s.name           = 'DevClientSafety'
  s.version        = '1.0.0'
  s.summary        = 'Development-client server picker guard for Rabbithole'
  s.description    = 'Prunes foreign Expo development servers from this app own UserDefaults after a verified directed launch.'
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

  s.frameworks = 'Foundation'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
