Pod::Spec.new do |s|
  s.name           = 'OutputVolume'
  s.version        = '1.0.0'
  s.summary        = 'Reads the iPad output volume for Rabbithole'
  s.description    = 'A local Expo module that reports AVAudioSession.outputVolume and emits change events (KVO), so pre-reader voice mode can ask for the volume to be turned up.'
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

  s.frameworks = 'AVFoundation'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
