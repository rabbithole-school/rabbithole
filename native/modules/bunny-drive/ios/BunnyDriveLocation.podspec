Pod::Spec.new do |s|
  s.name           = 'BunnyDriveLocation'
  s.version        = '1.0.0'
  s.summary        = 'Registers the Bunny Drive location in Files'
  s.description    = 'A local Expo module with no JS API. At launch it tells iOS about the Bunny Drive file provider domain, which only the containing app can do.'
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

  s.frameworks = 'FileProvider'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
