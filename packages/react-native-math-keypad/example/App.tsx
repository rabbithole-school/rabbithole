// A minimal screen: one flat answer and one built answer.
import { useState } from "react";
import { Button, SafeAreaView, Text } from "react-native";
import { MathAnswerInput } from "react-native-math-keypad";

export default function App() {
  const [area, setArea] = useState("");
  const [mixed, setMixed] = useState("");

  return (
    <SafeAreaView style={{ flex: 1, padding: 24, gap: 24 }}>
      <Text>A rectangle is 8 cm by 14 cm. What is its area?</Text>
      <MathAnswerInput
        answerType="integer"
        unit="cm²"
        value={area}
        onChange={setArea}
        onSubmit={() => console.log("area:", area)} // "112 cm²"
      />

      <Text>Write 5/2 as a mixed number.</Text>
      <MathAnswerInput
        kind="builder"
        onChange={setMixed} // "" until every box is filled, then "2 1/2"
        onSubmit={() => console.log("mixed:", mixed)}
      />
      <Button title="Check" disabled={!mixed} onPress={() => console.log(mixed)} />
    </SafeAreaView>
  );
}
