import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import java.awt.FlowLayout;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;

public class Main {
    public static void main(String[] args) {
        // 1. Create the main window frame
        JFrame frame = new JFrame("My First Java GUI");
        frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        frame.setSize(300, 200);
        frame.setLayout(new FlowLayout());

        // 2. Create UI components
        JLabel label = new JLabel("Click the button below:");
        JButton button = new JButton("Click Me!");

        // 3. Add an action listener to handle button clicks
        button.addActionListener(new ActionListener() {
            @Override
            public void actionPerformed(ActionEvent e) {
                label.setText("Button was clicked! 🎉");
            }
        });

        // 4. Add elements to the frame and make it visible
        frame.add(label);
        frame.add(button);
        frame.setVisible(true);
    }
}
